export function number(value, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(Number(value || 0));
}

export function printAccount(account, write = console.log) {
  write(`User: ${account.username}`);
  write(`Points: ${number(account.points)}`);
  write(`Used: ${number(account.total_points_used)} points`);
  write(`API billing: ${account.api_billing_mode === 'admin_exempt' ? 'admin exempt' : 'points'}`);
}

export function printModels(payload, write = console.log) {
  for (const model of payload.data || []) write(`${model.id.padEnd(12)} ${model.name || model.id}`);
}

export function printUsage(payload, write = console.log) {
  const summary = payload.summary || {};
  write(`Requests: ${number(summary.requests, 0)}  Tokens: ${number(summary.tokens, 0)}  Points: ${number(summary.points_used)}`);
  write(`Remaining: ${number(payload.points_remaining)} points`);
  if (!(payload.data || []).length) {
    write('No usage yet.');
    return;
  }
  write('');
  for (const row of payload.data) {
    write(`${row.created_at}  ${String(row.model).padEnd(10)} ${String(row.channel).padEnd(4)} ${number(row.total_tokens, 0)} tokens  ${number(row.points_used)} points`);
  }
}
