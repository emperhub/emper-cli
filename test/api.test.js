import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApiClient } from '../src/api.js';
import { streamAnswer } from '../src/cli.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('API client reads metadata and streams chat text', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method:req.method, url:req.url, authorization:req.headers.authorization });
    if (req.headers.authorization !== 'Bearer ask-test-12345678') {
      res.writeHead(401, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ error:{ message:'bad key ask-leaked-secret-123456789', code:'invalid_api_key' } }));
      return;
    }
    if (req.url === '/v1/me') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object:'account', username:'tester', points:42, total_points_used:2, is_admin:false, api_billing_mode:'points' }));
      return;
    }
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object:'list', data:[{ id:'nova-x1', name:'Nova X1' }] }));
      return;
    }
    if (req.url === '/v1/usage?limit=7') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object:'list', data:[], summary:{ requests:0, tokens:0, points_used:0 }, points_remaining:42 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type':'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id:'one', object:'chat.completion.chunk', created:1, model:'nova-x1', choices:[{ index:0, delta:{ content:'Hello' }, finish_reason:null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id:'one', object:'chat.completion.chunk', created:1, model:'nova-x1', choices:[{ index:0, delta:{ content:' world' }, finish_reason:'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => server.close());
  const api = createApiClient({ apiKey:'ask-test-12345678', baseURL:`http://127.0.0.1:${port}/v1` });

  assert.equal((await api.me()).username, 'tester');
  assert.deepEqual((await api.models()).data.map(model => model.id), ['nova-x1']);
  assert.equal((await api.usage(7)).points_remaining, 42);
  const chunks = [];
  assert.equal(await streamAnswer(api, { model:'nova-x1', messages:[{ role:'user', content:'Hi' }], maxTokens:50 }, value => chunks.push(value)), 'Hello world');
  assert.equal(chunks.join(''), 'Hello world');
  assert.equal(requests.every(request => request.authorization === 'Bearer ask-test-12345678'), true);
});

test('authentication errors are sanitized', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ error:{ message:'ask-leaked-secret-123456789 at https://provider.invalid', code:'invalid_api_key' } }));
  });
  const port = await listen(server);
  t.after(() => server.close());
  const api = createApiClient({ apiKey:'ask-wrong-12345678', baseURL:`http://127.0.0.1:${port}/v1` });
  await assert.rejects(api.me(), error => {
    assert.equal(error.status, 401);
    assert.match(error.message, /emper login/i);
    assert.doesNotMatch(error.message, /leaked|provider\.invalid|ask-wrong/);
    return true;
  });
});

test('server errors do not expose upstream details', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(502, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ error:{ message:'provider failed at https://private-provider.invalid/v1 using sk-secret-123456789' } }));
  });
  const port = await listen(server);
  t.after(() => server.close());
  const api = createApiClient({ apiKey:'ask-test-12345678', baseURL:`http://127.0.0.1:${port}/v1` });
  await assert.rejects(api.me(), error => {
    assert.match(error.message, /temporarily unavailable/i);
    assert.doesNotMatch(error.message, /provider|private-provider|secret/);
    return true;
  });
});
