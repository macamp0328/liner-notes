# CloudWatch observability for graph-service.
#
# Issue: https://github.com/macamp0328/liner-notes/issues/117
#
# Two layers:
#   1. Logs out of the cluster — fluent-bit (installed via helm per the runbook)
#      ships pod stdout to the CloudWatch Log Group declared here.
#   2. Alarms on the failure modes that actually cause outages on a single-replica
#      deployment — pod restarts, health endpoint failing, EC2 instance impairment.
#      All three notify a single SNS topic with one email subscriber.
#
# Metrics dashboards, Prometheus, and APM are deliberately out of scope at this
# scale. See infra/RUNBOOK.md for the post-apply fluent-bit install procedure.

# ---------------------------------------------------------------------------
# Log Group — fluent-bit destination.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "graph_service" {
  name              = "/${local.name_prefix}/graph-service"
  retention_in_days = 30
}

# ---------------------------------------------------------------------------
# SNS — single topic, single subscriber. All alarms publish here.
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "${local.name_prefix}-alerts"
}

# Email subscriptions require manual confirmation — AWS sends a confirmation
# link to this address on apply. Until clicked, the subscription stays in
# "PendingConfirmation" and alarms are not delivered.
resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = "macamp0328@gmail.com"
}

# ---------------------------------------------------------------------------
# Pod-restart detection.
#
# Matches kubelet log lines that indicate a pod was killed or is crash-looping.
# fluent-bit must be configured to ship the k3s systemd journal into the same
# log group as the pod stdout — pod stdout alone doesn't include these
# messages. See infra/RUNBOOK.md "Observability — fluent-bit and alarms" (Step 10)
# and infra/k8s/aws-for-fluent-bit/values.yaml for the systemd input configuration.
#
# Pattern phrases verified against actual kubelet output on AL2023 + k3s:
#   - "Liveness probe failed"  → kubelet's standard wording when an HTTP
#                                liveness probe returns non-2xx.
#   - "CrashLoopBackOff"       → the unique Kubernetes state name; appears
#                                verbatim in every kubelet "Error syncing pod"
#                                log line when a container is crash-looping.
#                                More reliable than the "Back-off restarting
#                                failed container" wording, which is in
#                                Kubernetes Events (etcd) but uses lowercased
#                                "back-off Xs restarting failed container=NAME"
#                                in kubelet's stdout/journal — a substring
#                                mismatch with the cleaner phrasing.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "pod_restarts" {
  name           = "${local.name_prefix}-pod-restarts"
  log_group_name = aws_cloudwatch_log_group.graph_service.name
  pattern        = "?\"Liveness probe failed\" ?\"CrashLoopBackOff\""

  metric_transformation {
    name      = "PodRestarts"
    namespace = "${local.name_prefix}/graph-service"
    value     = "1"
    unit      = "Count"
    # `default_value` keeps the metric reporting 0 instead of going to "no data"
    # when there are no matching log lines — required for `treat_missing_data`
    # on the alarm to behave as expected.
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "pod_restarts" {
  alarm_name          = "${local.name_prefix}-pod-restarts"
  alarm_description   = "graph-service pod restarted or failed a liveness probe in the last 5 minutes."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  period              = 300
  threshold           = 0
  treat_missing_data  = "notBreaching"

  metric_name = aws_cloudwatch_log_metric_filter.pod_restarts.metric_transformation[0].name
  namespace   = aws_cloudwatch_log_metric_filter.pod_restarts.metric_transformation[0].namespace
  statistic   = "Sum"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------------------
# Route 53 health check — external blackbox probe of /api/v1/health.
#
# Cheaper than a CloudWatch Synthetic Canary (~$0.50/mo vs. ~$3/mo) and
# alarms directly on the HealthCheckStatus metric. Trade-off: can only assert
# response status code, not body — fine for the health endpoint, which
# returns 200 on success and 503 when Neo4j is disconnected.
#
# Route 53 health check metrics are published only to us-east-1. The alarm
# below uses the aws.us_east_1 provider alias (declared in main.tf) so it
# always reads from the right region regardless of var.aws_region.
# ---------------------------------------------------------------------------

resource "aws_route53_health_check" "graph_service" {
  type              = "HTTP"
  ip_address        = aws_eip.k3s.public_ip
  port              = 30080
  resource_path     = "/api/v1/health"
  request_interval  = 30
  failure_threshold = 3

  tags = {
    Name = "${local.name_prefix}-health"
  }
}

resource "aws_cloudwatch_metric_alarm" "health_check" {
  provider = aws.us_east_1

  alarm_name          = "${local.name_prefix}-health-check"
  alarm_description   = "graph-service /api/v1/health is failing from Route 53 external probers."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  period              = 60
  threshold           = 1
  treat_missing_data  = "breaching"

  metric_name = "HealthCheckStatus"
  namespace   = "AWS/Route53"
  statistic   = "Minimum"

  dimensions = {
    HealthCheckId = aws_route53_health_check.graph_service.id
  }

  # SNS topic lives in the default-region account scope; cross-region alarm →
  # SNS is supported by CloudWatch.
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------------------
# EC2 instance status check — built-in AWS metric covering both system and
# instance reachability. Fires on hypervisor-level failures (host hardware,
# network) as well as instance-level problems (kernel panic, no route).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ec2_status_check" {
  alarm_name          = "${local.name_prefix}-ec2-status-check"
  alarm_description   = "k3s EC2 instance failed an AWS status check (system or instance)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  period              = 60
  threshold           = 0
  treat_missing_data  = "breaching"

  metric_name = "StatusCheckFailed"
  namespace   = "AWS/EC2"
  statistic   = "Maximum"

  dimensions = {
    InstanceId = aws_instance.k3s.id
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}
