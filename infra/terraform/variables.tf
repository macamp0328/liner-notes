# Terraform variables — production environment.

variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name used as a prefix for all resource names."
  type        = string
  default     = "liner-notes"
}

variable "instance_type" {
  description = "EC2 instance type for the k3s node. t3.small (2 vCPU / 2 GB) is the minimum that runs k3s + External Secrets Operator + graph-service without OOMing — t3.micro (1 GB) thrashes and the API server stops responding."
  type        = string
  default     = "t3.small"
}

variable "ssh_key_name" {
  description = "Name of an existing EC2 key pair to attach to the instance. Leave null to skip — operators can use SSM Session Manager once IAM is set up."
  type        = string
  default     = null
}

variable "allow_ssh_cidr" {
  description = "CIDR blocks permitted to SSH (port 22) into the k3s node. Empty list disables SSH from the security group; rely on SSM Session Manager instead."
  type        = list(string)
  default     = []
}

variable "allow_app_cidr" {
  description = "CIDR blocks permitted to reach the graph-service NodePort (30080). Default is open to the world; narrow this for tighter exposure."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
