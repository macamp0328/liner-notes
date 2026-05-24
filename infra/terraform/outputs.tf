# Outputs surfaced after `terraform apply` — referenced from infra/RUNBOOK.md.

output "ecr_repository_url" {
  description = "Push graph-service images here."
  value       = aws_ecr_repository.graph_service.repository_url
}

output "ec2_public_ip" {
  description = "Public IP of the k3s node."
  value       = aws_instance.k3s.public_ip
}

output "ec2_public_dns" {
  description = "Public DNS name of the k3s node."
  value       = aws_instance.k3s.public_dns
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
  value       = "http://${aws_instance.k3s.public_dns}:30080"
}
