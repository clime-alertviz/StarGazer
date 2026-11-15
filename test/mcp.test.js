import test from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal, call } from '../scripts/mcp-client.js';

test('real stdio MCP session: discovery → profiles → plan → Calendar payload; failures stay structured', async () => {
  const client = await connectLocal();
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some(t => t.name === 'plan_outing'));
    const profiles = await call(client, 'load_profiles');
    assert.equal(profiles.participants.length, 4);
    const scenario = await call(client, 'load_demo_scenario');
    const plan = await call(client, 'plan_outing', scenario);
    assert.equal(plan.status, 'proposal');
    const draft = await call(client, 'prepare_calendar_invitation', { planId: plan.planId });
    assert.equal(draft.status, 'demo_do_not_send');
    assert.equal(draft.arguments.attendees.length, 3);
    // Fake connector sink checks the exact outgoing contract; no external invitation.
    const fakeCalendar = async payload => {
      assert.equal(payload.notify, true); assert.equal(payload.visibility, 'private');
      assert.ok(Date.parse(payload.end_time) > Date.parse(payload.start_time));
      assert.ok(payload.description.includes(plan.planId));
      return { id: 'fixture-event-id', htmlLink: 'https://calendar.google.com/fixture-not-a-real-event' };
    };
    assert.equal((await fakeCalendar(draft.arguments)).id, 'fixture-event-id');
    const bad = await client.callTool({ name: 'prepare_calendar_invitation', arguments: { planId: '00000000-0000-4000-8000-000000000000' } });
    assert.equal(bad.isError, true);
    const invalid = await client.callTool({ name: 'plan_outing', arguments: {} });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});

test('live server starts without keys, exposes no demo tool, and reports missing setup', async () => {
  const client = await connectLocal({ demo: false });
  try {
    assert.ok(!(await client.listTools()).tools.some(t => t.name === 'load_demo_scenario'));
    if (!process.env.GEOAPIFY_API_KEY) await assert.rejects(call(client, 'get_geoapify_tools'), /GEOAPIFY_API_KEY/);
  } finally { await client.close(); }
});
