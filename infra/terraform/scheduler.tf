# Scale-to-zero power switch for the k3s node.
#
# A small Lambda is the single control point: it starts/stops the EC2 instance,
# suppresses the two transient alarms while the node is intentionally stopped
# (see observability.tf — both use treat_missing_data = "breaching", so a bare
# stop would page every night), and enables/disables the nightly cost-saving
# schedule. It is invoked two ways:
#
#   - the EventBridge schedules below (the "auto" nightly stop/start), and
#   - `pnpm power:on|off|auto|status` (scripts/admin/power.sh), which invokes
#     this Lambda directly with the chosen action.
#
# Operator procedures live in infra/RUNBOOK.md.

locals {
  scheduler_function_name = "${local.name_prefix}-instance-scheduler"
  stop_schedule_name      = "${local.name_prefix}-instance-stop"
  start_schedule_name     = "${local.name_prefix}-instance-start"

  # Constructed (not referenced from the schedule resources) so the Lambda's
  # IAM policy can grant access without creating a policy → schedule → Lambda →
  # policy dependency cycle.
  schedule_arn_prefix = "arn:aws:scheduler:${var.aws_region}:${data.aws_caller_identity.current.account_id}:schedule/default"
}

# --- Lambda package -------------------------------------------------------

data "archive_file" "instance_scheduler" {
  type        = "zip"
  source_file = "${path.module}/lambda/instance_scheduler.py"
  output_path = "${path.module}/lambda/instance_scheduler.zip"
}

# Default SSE — same rationale as the graph-service log group (no secrets).
#trivy:ignore:AVD-AWS-0017
resource "aws_cloudwatch_log_group" "instance_scheduler" {
  name              = "/aws/lambda/${local.scheduler_function_name}"
  retention_in_days = 30
}

# No X-Ray tracing: a 30-second cron start/stop function — CloudWatch logs are
# ample for debugging it.
#trivy:ignore:AVD-AWS-0066
resource "aws_lambda_function" "instance_scheduler" {
  function_name = local.scheduler_function_name
  description   = "Start/stop the k3s node and toggle the nightly cost-saving schedule."
  role          = aws_iam_role.instance_scheduler.arn
  handler       = "instance_scheduler.handler"
  runtime       = "python3.12"
  timeout       = 30

  filename         = data.archive_file.instance_scheduler.output_path
  source_code_hash = data.archive_file.instance_scheduler.output_base64sha256

  environment {
    variables = {
      INSTANCE_ID = aws_instance.k3s.id
      # `name@region` pairs — the alarms don't share a region. The EC2
      # status-check alarm lives in the deploy region; the health-check alarm
      # is pinned to us-east-1 (provider aws.us_east_1 in observability.tf,
      # because Route 53 health-check metrics only publish there). The Lambda
      # toggles each alarm in its own region.
      ALARM_NAMES = join(",", [
        "${aws_cloudwatch_metric_alarm.ec2_status_check.alarm_name}@${var.aws_region}",
        "${aws_cloudwatch_metric_alarm.health_check.alarm_name}@us-east-1",
      ])
      SCHEDULE_NAMES = join(",", [local.stop_schedule_name, local.start_schedule_name])
    }
  }

  depends_on = [aws_cloudwatch_log_group.instance_scheduler]
}

# --- Lambda execution role ------------------------------------------------

data "aws_iam_policy_document" "instance_scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance_scheduler" {
  name               = "${local.name_prefix}-instance-scheduler"
  assume_role_policy = data.aws_iam_policy_document.instance_scheduler_assume.json
}

resource "aws_iam_role_policy_attachment" "instance_scheduler_logs" {
  role       = aws_iam_role.instance_scheduler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "instance_scheduler" {
  statement {
    sid       = "ControlInstancePower"
    actions   = ["ec2:StartInstances", "ec2:StopInstances"]
    resources = ["arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.k3s.id}"]
  }

  # DescribeInstances has no resource-level scoping in IAM.
  statement {
    sid       = "DescribeInstances"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  statement {
    sid     = "ToggleTransientAlarms"
    actions = ["cloudwatch:EnableAlarmActions", "cloudwatch:DisableAlarmActions"]
    resources = [
      aws_cloudwatch_metric_alarm.ec2_status_check.arn,
      aws_cloudwatch_metric_alarm.health_check.arn,
    ]
  }

  statement {
    sid     = "ManageCostSavingSchedule"
    actions = ["scheduler:GetSchedule", "scheduler:UpdateSchedule"]
    resources = [
      "${local.schedule_arn_prefix}/${local.stop_schedule_name}",
      "${local.schedule_arn_prefix}/${local.start_schedule_name}",
    ]
  }

  # UpdateSchedule re-submits the schedule's target role, which requires
  # PassRole on that role.
  statement {
    sid       = "PassSchedulerInvokeRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.scheduler_invoke.arn]
  }
}

resource "aws_iam_role_policy" "instance_scheduler" {
  name   = "${local.name_prefix}-instance-scheduler"
  role   = aws_iam_role.instance_scheduler.id
  policy = data.aws_iam_policy_document.instance_scheduler.json
}

# --- EventBridge Scheduler invocation role --------------------------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler_invoke" {
  name               = "${local.name_prefix}-scheduler-invoke"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler_invoke" {
  statement {
    sid       = "InvokeInstanceScheduler"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.instance_scheduler.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name   = "${local.name_prefix}-scheduler-invoke"
  role   = aws_iam_role.scheduler_invoke.id
  policy = data.aws_iam_policy_document.scheduler_invoke.json
}

# --- Nightly cost-saving schedules ----------------------------------------
#
# state is set from var.nightly_schedule_enabled on first apply, then owned by
# the runtime switch (`pnpm power:on|off|auto`) — ignore_changes keeps a later
# apply from reverting whatever the operator last toggled.

resource "aws_scheduler_schedule" "stop" {
  name = local.stop_schedule_name

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = var.scheduler_stop_cron
  schedule_expression_timezone = var.scheduler_timezone
  state                        = var.nightly_schedule_enabled ? "ENABLED" : "DISABLED"

  target {
    arn      = aws_lambda_function.instance_scheduler.arn
    role_arn = aws_iam_role.scheduler_invoke.arn
    input    = jsonencode({ action = "stop" })
  }

  lifecycle {
    ignore_changes = [state]
  }
}

resource "aws_scheduler_schedule" "start" {
  name = local.start_schedule_name

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = var.scheduler_start_cron
  schedule_expression_timezone = var.scheduler_timezone
  state                        = var.nightly_schedule_enabled ? "ENABLED" : "DISABLED"

  target {
    arn      = aws_lambda_function.instance_scheduler.arn
    role_arn = aws_iam_role.scheduler_invoke.arn
    input    = jsonencode({ action = "start" })
  }

  lifecycle {
    ignore_changes = [state]
  }
}
