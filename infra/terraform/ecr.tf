# Container registry for graph-service images.

resource "aws_ecr_repository" "graph_service" {
  name                 = "${local.name_prefix}/graph-service"
  image_tag_mutability = "MUTABLE"

  # Allow `terraform destroy` to remove the repo even when images are still
  # pushed to it. Without this, teardown fails on a non-empty repository and
  # the operator has to `aws ecr batch-delete-image` first.
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# Keep the registry small: the last 10 tagged images, plus a sweep for untagged
# layers older than 14 days. ECR Free Tier is 500MB; this keeps usage well below.
resource "aws_ecr_lifecycle_policy" "graph_service" {
  repository = aws_ecr_repository.graph_service.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 10
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images older than 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
    ]
  })
}
