# Outputs surfaced after `terraform apply` — referenced from infra/RUNBOOK.md.

output "aws_region" {
  description = "AWS region this deploy lives in. Runbook commands echo through `$REGION`; without this output the runbook would silently fall back to us-east-1."
  value       = var.aws_region
}

output "ecr_repository_url" {
  description = "Push graph-service images here."
  value       = aws_ecr_repository.graph_service.repository_url
}

output "ec2_public_ip" {
  description = "Public IP of the k3s node (Elastic IP — stable across stop/start)."
  value       = aws_eip.k3s.public_ip
}

output "ec2_public_dns" {
  description = "Public DNS name of the k3s node (resolves to the Elastic IP)."
  value       = aws_eip.k3s.public_dns
}

output "ec2_instance_id" {
  description = "Use this with `aws ssm start-session` for shell access without SSH."
  value       = aws_instance.k3s.id
}

output "secrets_manager_arn" {
  description = "ARN of the secret holding graph-service runtime env vars. Populate via the AWS console after apply."
  value       = aws_secretsmanager_secret.graph_service.arn
}

output "secrets_manager_name" {
  description = "Name of the secret — used by the ExternalSecret manifest."
  value       = aws_secretsmanager_secret.graph_service.name
}

output "service_url" {
  description = "Where graph-service will be reachable once deployed."
  value       = "http://${aws_eip.k3s.public_dns}:30080"
}

output "log_group_name" {
  description = "CloudWatch Log Group fluent-bit ships graph-service pod stdout into. Referenced by the runbook helm-install command."
  value       = aws_cloudwatch_log_group.graph_service.name
}

output "sns_topic_arn" {
  description = "ARN of the SNS topic that fans out graph-service alarms to email subscribers."
  value       = aws_sns_topic.alerts.arn
}

output "health_check_id" {
  description = "Route 53 health check ID probing /api/v1/health. Use in the AWS console under Route 53 → Health checks to see live status."
  value       = aws_route53_health_check.graph_service.id
}

output "dashboard_url" {
  description = "CloudWatch dashboard for graph-service — alarms, EC2 health, log activity at one URL. Referenced from infra/RUNBOOK.md."
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.graph_service.dashboard_name}"
}

output "instance_scheduler_function_name" {
  description = "Lambda the power switch invokes. Set as SCHEDULER_LAMBDA_NAME for scripts/admin/power.sh if you override project_name."
  value       = aws_lambda_function.instance_scheduler.function_name
}

output "instance_schedule_names" {
  description = "Names of the nightly stop/start EventBridge schedules toggled by `pnpm power:auto`/`off`."
  value       = [aws_scheduler_schedule.stop.name, aws_scheduler_schedule.start.name]
}

output "github_deploy_role_arn" {
  description = "ARN of the role the CD workflow (#120) assumes via GitHub OIDC. Record as the AWS_DEPLOY_ROLE_ARN GitHub Actions variable — see the 'CD — IAM bootstrap' section of infra/RUNBOOK.md."
  value       = aws_iam_role.github_deploy.arn
}
