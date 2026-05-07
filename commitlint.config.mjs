export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // URLs in commit footers (e.g. Agent-Logs-Url) cannot be wrapped; disable line limit.
    'body-max-line-length': [0],
  },
};
