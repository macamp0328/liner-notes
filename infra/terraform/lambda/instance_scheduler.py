"""Start/stop the k3s EC2 node and manage the cost-saving schedule.

Single control point for scale-to-zero. Invoked two ways:

  - EventBridge Scheduler fires {"action": "stop"} at night and
    {"action": "start"} in the morning (the "auto" cost-saver).
  - An operator runs `pnpm power:on|off|auto|status`, which invokes this
    Lambda with the matching action.

Why a Lambda instead of EventBridge hitting EC2 directly: stopping the
instance silences the StatusCheckFailed and Route 53 health-check metrics,
and both alarms are configured `treat_missing_data = "breaching"`, so a bare
stop would page the operator every night. This function disables those two
alarms' actions before stopping and re-enables them after starting, so the
"asleep" state stays quiet while a genuine outage of a *running* node still
alerts.

Re-enabling at start (rather than after the node is healthy) is safe only
because the two suppressed alarms named in ALARM_NAMES — the EC2 status-check
and Route 53 health-check alarms — have no ok_actions (see their definitions
in infra/terraform/observability.tf; the other alarms there keep ok_actions):
the instance takes minutes to boot, so the ALARM→OK recovery lands *after*
actions are back on, and with ok_actions wired that transition emailed the
operator every morning.

Environment:
  INSTANCE_ID     - the EC2 instance to control.
  ALARM_NAMES     - comma-separated `name@region` pairs of CloudWatch alarms to
                    suppress while the instance is intentionally stopped. The
                    region is explicit per alarm because the alarms don't all
                    live in the same region: the EC2 status-check alarm is in
                    the deploy region, but the Route 53 health-check alarm is
                    always in us-east-1 (that's the only region Route 53
                    health-check metrics publish to). enable/disable_alarm_actions
                    silently no-ops on a name absent from the client's region,
                    so a single client in the Lambda's region would leave the
                    health alarm un-suppressed whenever aws_region is overridden.
  SCHEDULE_NAMES  - comma-separated EventBridge Scheduler schedule names that
                    make up the nightly cost-saver (the stop + start pair).
"""

import os

import boto3

ec2 = boto3.client("ec2")
scheduler = boto3.client("scheduler")

INSTANCE_ID = os.environ["INSTANCE_ID"]
SCHEDULE_NAMES = [
    name for name in os.environ.get("SCHEDULE_NAMES", "").split(",") if name
]

_cloudwatch_clients = {}


def _alarms_by_region():
    """Parse ALARM_NAMES ("name@region,...") into {region: [names]}."""
    by_region = {}
    for entry in os.environ.get("ALARM_NAMES", "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        name, _, region = entry.partition("@")
        by_region.setdefault(region, []).append(name)
    return by_region


def _cloudwatch(region):
    if region not in _cloudwatch_clients:
        _cloudwatch_clients[region] = boto3.client("cloudwatch", region_name=region)
    return _cloudwatch_clients[region]


def _set_alarm_actions(enabled):
    for region, names in _alarms_by_region().items():
        client = _cloudwatch(region)
        if enabled:
            client.enable_alarm_actions(AlarmNames=names)
        else:
            client.disable_alarm_actions(AlarmNames=names)


def _set_schedule_state(state):
    """Enable or disable the nightly schedules.

    UpdateSchedule is a full replace, so the existing definition is read back
    and re-submitted with only State changed.
    """
    for name in SCHEDULE_NAMES:
        current = scheduler.get_schedule(Name=name)
        params = {
            "Name": current["Name"],
            "GroupName": current.get("GroupName", "default"),
            "ScheduleExpression": current["ScheduleExpression"],
            "FlexibleTimeWindow": current["FlexibleTimeWindow"],
            "Target": current["Target"],
            "State": state,
        }
        if current.get("ScheduleExpressionTimezone"):
            params["ScheduleExpressionTimezone"] = current["ScheduleExpressionTimezone"]
        if current.get("Description"):
            params["Description"] = current["Description"]
        scheduler.update_schedule(**params)


def _start():
    # Re-enable alarms even if the start call fails — a node that didn't come
    # back up should page, not sit silently with its monitoring disabled.
    try:
        ec2.start_instances(InstanceIds=[INSTANCE_ID])
    finally:
        _set_alarm_actions(True)


def _stop():
    # Disable alarms first so the planned stop doesn't page, but roll the
    # suppression back if the stop fails — a still-running node must stay
    # monitored.
    _set_alarm_actions(False)
    try:
        ec2.stop_instances(InstanceIds=[INSTANCE_ID])
    except Exception:
        _set_alarm_actions(True)
        raise


def _instance_state():
    result = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
    return result["Reservations"][0]["Instances"][0]["State"]["Name"]


def _schedule_states():
    return {name: scheduler.get_schedule(Name=name).get("State") for name in SCHEDULE_NAMES}


def handler(event, _context):
    action = (event or {}).get("action", "status")

    if action == "start":
        _start()
    elif action == "stop":
        _stop()
    elif action == "on":
        _set_schedule_state("DISABLED")
        _start()
    elif action == "off":
        _set_schedule_state("DISABLED")
        _stop()
    elif action == "auto":
        _set_schedule_state("ENABLED")
        _start()
    elif action == "status":
        pass
    else:
        raise ValueError(f"unknown action: {action!r}")

    return {
        "action": action,
        "instance": _instance_state(),
        "schedules": _schedule_states(),
    }
