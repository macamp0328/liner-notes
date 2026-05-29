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

Environment:
  INSTANCE_ID     - the EC2 instance to control.
  ALARM_NAMES     - comma-separated CloudWatch alarm names to suppress while
                    the instance is intentionally stopped.
  SCHEDULE_NAMES  - comma-separated EventBridge Scheduler schedule names that
                    make up the nightly cost-saver (the stop + start pair).

The CloudWatch client uses the Lambda's own region. The default deployment is
single-region (us-east-1), where both alarms live; a multi-region deployment
would need the alarms colocated with this function.
"""

import os

import boto3

ec2 = boto3.client("ec2")
cloudwatch = boto3.client("cloudwatch")
scheduler = boto3.client("scheduler")

INSTANCE_ID = os.environ["INSTANCE_ID"]
ALARM_NAMES = [name for name in os.environ.get("ALARM_NAMES", "").split(",") if name]
SCHEDULE_NAMES = [
    name for name in os.environ.get("SCHEDULE_NAMES", "").split(",") if name
]


def _set_alarm_actions(enabled):
    if not ALARM_NAMES:
        return
    if enabled:
        cloudwatch.enable_alarm_actions(AlarmNames=ALARM_NAMES)
    else:
        cloudwatch.disable_alarm_actions(AlarmNames=ALARM_NAMES)


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
    ec2.start_instances(InstanceIds=[INSTANCE_ID])
    _set_alarm_actions(True)


def _stop():
    _set_alarm_actions(False)
    ec2.stop_instances(InstanceIds=[INSTANCE_ID])


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
