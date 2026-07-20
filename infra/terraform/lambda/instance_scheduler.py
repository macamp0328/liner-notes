"""Start/stop the k3s EC2 node and manage the cost-saving schedule.

Single control point for scale-to-zero. Invoked three ways:

  - EventBridge Scheduler fires {"action": "stop"} at night and
    {"action": "start"} in the morning (the "auto" cost-saver).
  - An operator runs `pnpm power:on|off|auto|status`, which invokes this
    Lambda with the matching action.
  - The function invokes itself asynchronously with {"action": "rearm"}
    after every start (see below).

Why a Lambda instead of EventBridge hitting EC2 directly: stopping the
instance silences the StatusCheckFailed and Route 53 health-check metrics,
and both alarms are configured `treat_missing_data = "breaching"`, so a bare
stop would page the operator every night. This function disables those two
alarms' actions before stopping, and after a start re-enables them only once
the alarms have actually recovered to OK (the async "rearm" pass), so the
"asleep" state stays quiet while a genuine outage of a *running* node still
alerts.

Re-arming is deferred to a rearm invocation, not done inline at start, for
two reasons:

  - CloudWatch fires alarm actions only on state *transitions*. The alarms
    sit in ALARM all night while suppressed, so if the node never comes back
    there is no transition left to fire — blindly re-enabling actions at
    start time could never page for a failed start. The rearm pass pages
    explicitly (a direct SNS publish) when the start API call fails or the
    alarms don't recover within the rearm window.
  - Re-enabling actions before the alarms have recovered would let the
    morning ALARM→OK transition run with actions live (or, worse, a forced
    OK would flap back to ALARM mid-boot and page daily). Waiting until the
    alarms report OK keeps the planned nightly cycle producing zero
    notifications in either direction.

Environment:
  INSTANCE_ID      - the EC2 instance to control.
  ALARM_NAMES      - comma-separated `name@region` pairs of CloudWatch alarms
                     to suppress while the instance is intentionally stopped.
                     The region is explicit per alarm because the alarms don't
                     all live in the same region: the EC2 status-check alarm
                     is in the deploy region, but the Route 53 health-check
                     alarm is always in us-east-1 (that's the only region
                     Route 53 health-check metrics publish to).
                     enable/disable_alarm_actions silently no-ops on a name
                     absent from the client's region, so a single client in
                     the Lambda's region would leave the health alarm
                     un-suppressed whenever aws_region is overridden.
  SCHEDULE_NAMES   - comma-separated EventBridge Scheduler schedule names that
                     make up the nightly cost-saver (the stop + start pair).
  ALERTS_TOPIC_ARN - SNS topic paged directly when a start fails or the node
                     doesn't become healthy within the rearm window.
"""

import json
import os
import time

import boto3

ec2 = boto3.client("ec2")
scheduler = boto3.client("scheduler")
sns = boto3.client("sns")
lambda_client = boto3.client("lambda")

INSTANCE_ID = os.environ["INSTANCE_ID"]
ALERTS_TOPIC_ARN = os.environ["ALERTS_TOPIC_ARN"]
SCHEDULE_NAMES = [
    name for name in os.environ.get("SCHEDULE_NAMES", "").split(",") if name
]

# The rearm pass polls at this cadence until the alarms recover; the Lambda's
# configured timeout (scheduler.tf) is what bounds the overall grace window.
REARM_POLL_SECONDS = 30
# Headroom reserved below the timeout for the final enable + page calls, so
# the deadline path runs instead of the Lambda being killed mid-poll.
REARM_SAFETY_MS = 20_000

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


def _alarm_states():
    """Current StateValue per suppressed alarm, as {"name@region": state}.

    Raises on any configured alarm the API doesn't return — a typo'd
    ALARM_NAMES entry must fail loudly here, not silently pass the all-OK
    check in the rearm loop.
    """
    states = {}
    for region, names in _alarms_by_region().items():
        result = _cloudwatch(region).describe_alarms(AlarmNames=names)
        found = {alarm["AlarmName"]: alarm["StateValue"] for alarm in result["MetricAlarms"]}
        missing = sorted(set(names) - set(found))
        if missing:
            raise RuntimeError(f"alarms not found in {region}: {missing}")
        for name, state in found.items():
            states[f"{name}@{region}"] = state
    return states


def _page(subject, message):
    """Notify the operator directly via the alerts SNS topic."""
    sns.publish(TopicArn=ALERTS_TOPIC_ARN, Subject=subject, Message=message)


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


def _start(context):
    """Start the node and hand alarm re-arming to an async rearm invocation."""
    try:
        ec2.start_instances(InstanceIds=[INSTANCE_ID])
    except Exception as err:
        # The alarms are suppressed-in-ALARM, so no state transition will ever
        # fire for a node that stayed down — page explicitly. Actions are
        # still re-enabled so alarm behaviour is normal after a manual fix.
        _set_alarm_actions(True)
        # Re-raising lets Lambda's async retry (2 more attempts) re-run the
        # start — a transient EC2 error can self-heal. The cost is up to two
        # duplicate pages for a persistent failure; the message sets that
        # expectation so a retry that succeeds reads as "no further email".
        _page(
            "liner-notes: k3s node failed to start",
            f"start_instances failed for {INSTANCE_ID}; the node is likely "
            f"still stopped and its transient alarms are sitting in ALARM "
            f"(which cannot re-notify on their own).\n\n"
            f"This invocation will be retried automatically up to twice — "
            f"if no further email arrives, a retry succeeded and the node "
            f"recovered quietly.\n\nError: {err}",
        )
        raise
    try:
        lambda_client.invoke(
            FunctionName=context.invoked_function_arn,
            InvocationType="Event",
            Payload=json.dumps({"action": "rearm"}).encode(),
        )
    except Exception as err:
        # Degraded fallback: without a rearm pass, restore the old arm-at-start
        # behaviour rather than leave monitoring disabled indefinitely — and
        # page, because in this mode a started-but-never-healthy node would
        # sit silently in ALARM again. Re-raising lets the async retry take
        # another shot at the hand-off (the duplicate start is a no-op).
        _set_alarm_actions(True)
        _page(
            "liner-notes: alarm rearm hand-off failed",
            f"The node was started, but the async rearm self-invocation "
            f"failed; alarm actions were re-enabled immediately instead "
            f"(degraded mode). If the node does not come up healthy, the "
            f"alarms will sit in ALARM without notifying — verify manually."
            f"\n\nError: {err}",
        )
        raise


def _rearm(context):
    """Re-enable alarm actions once the alarms have actually recovered.

    Polls the suppressed alarms until every one reports OK, then re-enables
    their actions — the ALARM→OK recovery therefore always happens while
    actions are still disabled, which is what keeps the nightly cycle silent.

    If the alarms haven't recovered when the Lambda timeout looms, the node
    started but never became healthy: re-enable actions and page explicitly —
    unless the instance is stopping/stopped again, in which case a power:off
    superseded this start mid-rearm and its suppression is left in place.

    Any unexpected error also re-enables actions and pages: a broken rearm
    must be loud, never a silent loss of monitoring.
    """
    try:
        while True:
            states = _alarm_states()
            if all(state == "OK" for state in states.values()):
                _set_alarm_actions(True)
                return {"rearm": "armed", "alarms": states}
            remaining_ms = context.get_remaining_time_in_millis()
            if remaining_ms < REARM_POLL_SECONDS * 1000 + REARM_SAFETY_MS:
                break
            time.sleep(REARM_POLL_SECONDS)
    except Exception as err:
        _set_alarm_actions(True)
        _page(
            "liner-notes: alarm re-arm failed",
            f"The post-start rearm pass crashed; alarm actions were "
            f"re-enabled, but verify the node and alarms manually.\n\n"
            f"Error: {err}",
        )
        raise

    instance = _instance_state()
    if instance in ("stopping", "stopped"):
        return {"rearm": "superseded", "instance": instance, "alarms": states}

    _set_alarm_actions(True)
    unhealthy = {name: state for name, state in states.items() if state != "OK"}
    _page(
        "liner-notes: node started but did not become healthy",
        f"Instance {INSTANCE_ID} is '{instance}' but these alarms never "
        f"returned to OK within the rearm window: {unhealthy}.\n\n"
        f"The alarms cannot re-notify from a standing ALARM state, so this "
        f"is the only page you will get — investigate the node (see "
        f"infra/RUNBOOK.md, 'What to expect on a cold start').",
    )
    return {"rearm": "unhealthy", "alarms": states}


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


def handler(event, context):
    action = (event or {}).get("action", "status")

    if action == "start":
        _start(context)
    elif action == "stop":
        _stop()
    elif action == "on":
        _set_schedule_state("DISABLED")
        _start(context)
    elif action == "off":
        _set_schedule_state("DISABLED")
        _stop()
    elif action == "auto":
        _set_schedule_state("ENABLED")
        _start(context)
    elif action == "rearm":
        result = _rearm(context)
        result.setdefault("instance", _instance_state())
        result["action"] = action
        return result
    elif action == "status":
        pass
    else:
        raise ValueError(f"unknown action: {action!r}")

    return {
        "action": action,
        "instance": _instance_state(),
        "schedules": _schedule_states(),
    }
