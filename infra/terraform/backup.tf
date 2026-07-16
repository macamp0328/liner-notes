# Weekly graph backup to S3 (issue #104).
#
# The in-cluster `graph-backup` CronJob (infra/k8s/graph-service/backup-cronjob.yaml)
# streams the full Neo4j graph out as gzipped JSONL and uploads it here under the
# graph-backups/ prefix, authenticating via the EC2 instance role over IMDS — the
# same credential path ESO and the ecr-pull-secret-refresher already use. Retention
# is lifecycle-only (weekly cadence × ~8 weeks kept); restores are operator-run
# (`pnpm backup:restore` — see infra/RUNBOOK.md "Graph backup and restore").
#
# The CronJob learns the bucket name via a BACKUP_S3_BUCKET key the operator adds
# to the existing Secrets Manager secret (it flows through the ESO ExternalSecret
# into the pod env) — the account-id-suffixed name is resolved at apply time and
# never committed, matching the tfstate-bucket convention.

locals {
  backup_bucket_name = "${local.name_prefix}-graph-backups-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "graph_backups" {
  bucket = local.backup_bucket_name

  # Unlike the tfstate bucket, backups are disposable derived data — allow a clean
  # teardown to empty and remove the bucket (same rationale as ECR force_delete).
  force_destroy = true
}

# No versioning: objects are immutable write-once weekly files (the key embeds a
# full timestamp, so nothing is ever overwritten) and retention is purely the
# lifecycle expiration below — versioning would only silently retain noncurrent
# copies past the window.

# SSE-S3 (AES256) at no cost; the graph contains no secrets, but default-encrypting
# every bucket keeps the posture uniform with the tfstate bucket.
resource "aws_s3_bucket_server_side_encryption_configuration" "graph_backups" {
  bucket = aws_s3_bucket.graph_backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "graph_backups" {
  bucket = aws_s3_bucket.graph_backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "graph_backups" {
  bucket = aws_s3_bucket.graph_backups.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.graph_backups.arn,
          "${aws_s3_bucket.graph_backups.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
    ]
  })
}

# Retention: weekly cadence × 8 weeks kept ≈ 56 days; 60 gives slack for a
# catch-up run landing a day late after a power-off window. The multipart-abort
# rule is lib-storage hygiene — a backup pod killed mid-upload would otherwise
# leave invisible billed parts around forever.
resource "aws_s3_bucket_lifecycle_configuration" "graph_backups" {
  bucket = aws_s3_bucket.graph_backups.id

  rule {
    id     = "expire-old-backups"
    status = "Enabled"

    filter {
      prefix = "graph-backups/"
    }

    expiration {
      days = 60
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Write-only grant for the backup CronJob, scoped to the backup prefix. The job
# never lists or reads (restores run with the operator's own credentials), so
# neither ListBucket nor GetObject is granted. AbortMultipartUpload is separate
# from PutObject and is what lib-storage calls to clean up a failed upload.
data "aws_iam_policy_document" "backup_write" {
  statement {
    sid = "WriteGraphBackups"
    actions = [
      "s3:PutObject",
      "s3:AbortMultipartUpload",
    ]
    resources = [
      "${aws_s3_bucket.graph_backups.arn}/graph-backups/*",
    ]
  }
}

resource "aws_iam_role_policy" "backup_write" {
  name   = "${local.name_prefix}-backup-write"
  role   = aws_iam_role.ec2_k3s.id
  policy = data.aws_iam_policy_document.backup_write.json
}
