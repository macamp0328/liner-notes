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
  name              = "/liner-notes/graph-service"
  retention_in_days = 30
}
