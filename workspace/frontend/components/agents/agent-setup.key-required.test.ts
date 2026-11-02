// @vitest-environment jsdom
/**
 * Every agent the form adds or saves runs on something. A type with no sign-in
 * of its own (DeepSeek) runs on a key: a saved one, the agent's current one,
 * or the key its type has on the device, when the device says it has one. A
 * type with a sign-in runs on a key or on the account its CLI is signed in to
 * on the device, offered only once it is (agent-setup.auth.test.ts,
 * agent-setup.needs-credentials.test.ts). "Configure later" let in agents
 * that failed on their first message.
 */
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { messages } from '@/lib/i18n/messages/en-US';
import { translate } from '@/lib/i18n/translate';
import type { AgentCatalogDetail, AgentCatalogEntry, NodeAgent, NodeRuntime, WorkspaceNode } from '@/lib/types';
import { AgentSetup, type AgentSetupApi } from './agent-setup';
import deepseekEntry from '../../../backend/registry/deepseek.json';
import opencodeEntry from '../../../backend/registry/opencode.json';

const t = (key: string, params?: Record<string, string | number>) => translate(messages, messages, 'en-US', key, params);
vi.mock('@/lib/i18n', () => ({ useT: () => t }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Keep the form's state and submission real; use native selects for DOM events.
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) => createElement('select', { value, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onValueChange(e.target.value) }, children),
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => createElement('option', { value }, children),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); });

const ENTRIES: Record<string, { label: string }> = { deepseek: deepseekEntry, opencode: opencodeEntry };
const SAVED_KEY = {
  id: 'acc-deepseek', label: 'DeepSeek', provider: 'deepseek', baseUrl: null,
  apiKeyMasked: 'sk-2...98d7', createdBy: null, status: 'active', createdAt: null,
};

async function open({ type = 'deepseek', runtime = {}, editAgent, models = [] }: { type?: string; runtime?: Partial<NodeRuntime>; editAgent?: NodeAgent; models?: { id: string; label: string }[] } = {}) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const api = {
    getAgentCatalogDetail: vi.fn().mockResolvedValue({ ...ENTRIES[type], models } as unknown as AgentCatalogDetail),
    listModelAccess: vi.fn().mockResolvedValue([SAVED_KEY]),
    probeModelAccess: vi.fn().mockResolvedValue({ keyOk: true, models: [{ id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }] }),
    enqueueNodeCommand: vi.fn().mockResolvedValue({ commandId: 'cmd1' }),
  } as unknown as AgentSetupApi;
  const node = {
    nodeId: 'n1', name: 'LAPTOP-VON9RSJS', launcherVersion: '0.2.213',
    agents: editAgent ? [editAgent] : [],
    runtimes: [{ type, installed: true, ready: false, ...runtime }],
  } as unknown as WorkspaceNode;
  await act(async () => root.render(createElement(AgentSetup, {
    node, catalog: [{ name: type, label: ENTRIES[type].label } as AgentCatalogEntry], api,
    ...(editAgent ? { editAgent } : { initialType: type }),
    onBack: () => {}, onChanged: () => {}, onQueued: () => {},
  })));
  for (let i = 0; i < 3; i++) await act(async () => {});
  return api;
}

const credentialSelect = () => [...host.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === '__none__'))!;
const optionValues = () => [...credentialSelect().options].map((o) => o.value);
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
  for (let i = 0; i < 3; i++) await act(async () => {});
};
const submit = async () => {
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="agent-setup-submit"]')!.click());
  for (let i = 0; i < 3; i++) await act(async () => {});
};
const sent = (api: AgentSetupApi) => (api.enqueueNodeCommand as ReturnType<typeof vi.fn>).mock.calls;
const keyRequired = () => host.querySelector('[data-testid="agent-setup-creds-required"]');

it('does not add a key-only agent until a key is picked', async () => {
  const api = await open();
  expect(credentialSelect().selectedOptions[0].textContent).toBe(t('connect.byokPickKey'));
  expect(keyRequired()!.textContent).toContain(t('connect.byokKeyRequired', { label: deepseekEntry.label }));
  expect(keyRequired()!.getAttribute('role')).toBeNull();

  // No "Add anyway": every click is stopped and points at the key.
  await submit();
  await submit();
  expect(sent(api)).toEqual([]);
  expect(keyRequired()!.getAttribute('role')).toBe('alert');
  expect(host.querySelector('[data-testid="agent-setup-submit"]')!.textContent).toBe(t('connect.agentAddTitle'));
});

it('adds it on a saved key', async () => {
  const api = await open();
  await choose(credentialSelect(), SAVED_KEY.id);
  expect(keyRequired()).toBeNull();
  const modelSelect = [...host.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'deepseek-v4-flash'))!;
  await choose(modelSelect, 'deepseek-v4-flash');
  await submit();
  expect(sent(api)).toHaveLength(1);
  expect(sent(api)[0][1]).toBe('create_agent');
  expect(sent(api)[0][2]).toMatchObject({ type: 'deepseek', modelAccessId: SAVED_KEY.id, model: 'deepseek-v4-flash' });
});

it('offers the key the device has for the type, and adds the agent on it', async () => {
  const api = await open({ runtime: { ready: true, typeReady: true } });
  expect(optionValues()).toContain('__device_key__');
  // Offered, not picked for the user.
  await submit();
  expect(sent(api)).toEqual([]);

  await choose(credentialSelect(), '__device_key__');
  expect(keyRequired()).toBeNull();
  expect(host.querySelector('[data-testid="agent-setup-device-key-hint"]')!.textContent)
    .toBe(t('connect.byokDeviceKeyHint', { label: deepseekEntry.label, device: 'LAPTOP-VON9RSJS' }));
  await submit();
  expect(sent(api)).toHaveLength(1);
  const args = sent(api)[0][2];
  expect(args).not.toHaveProperty('apiKey');
  expect(args).not.toHaveProperty('modelAccessId');
  expect(args).not.toHaveProperty('authMode');
});

it("does not offer a key another agent holds, or one a device too old to say may hold", async () => {
  await open({ runtime: { ready: true, typeReady: false } });
  expect(optionValues()).not.toContain('__device_key__');
  await act(async () => root.unmount());
  host.remove();
  await open({ runtime: { ready: true } });
  expect(optionValues()).not.toContain('__device_key__');
});

it('does not save a key-only agent with no key of its own until one is picked', async () => {
  const api = await open({ editAgent: { name: 'deepseek', type: 'deepseek', status: 'stopped', authMode: null, apiKeyMasked: null } as NodeAgent });
  await submit();
  expect(sent(api)).toEqual([]);
  expect(keyRequired()!.getAttribute('role')).toBe('alert');
});

it('saves an agent on its own key as it is', async () => {
  const api = await open({ editAgent: { name: 'deepseek-keyed', type: 'deepseek', status: 'running', authMode: 'api_key', apiKeyMasked: 'sk-t...1234' } as NodeAgent });
  expect(credentialSelect().value).toBe('__keep_current__');
  expect(keyRequired()).toBeNull();
  await submit();
  expect(sent(api)).toHaveLength(1);
  expect(sent(api)[0][1]).toBe('configure_agent');
});

it('offers OpenCode the account it is signed in to, and asks for a key when it is not', async () => {
  // OpenCode signs in with `opencode auth login` (no login_command, so no
  // sign-in marker): the sign-in counts once the device has one.
  await open({ type: 'opencode', runtime: { ready: true, signedIn: true, loginCommand: 'agn login opencode' } });
  expect(optionValues()).toContain('__sign_in__');
  await act(async () => root.unmount());
  host.remove();

  const api = await open({ type: 'opencode' });
  expect(optionValues()).not.toContain('__sign_in__');
  await submit();
  expect(sent(api)).toEqual([]);
});

it('lets OpenCode run a free opencode/ model with neither', async () => {
  const api = await open({ type: 'opencode', models: [{ id: 'opencode/big-pickle', label: 'Big Pickle' }] });
  const modelSelect = [...host.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'opencode/big-pickle'))!;
  await choose(modelSelect, 'opencode/big-pickle');
  expect(keyRequired()).toBeNull();
  await submit();
  expect(sent(api)).toHaveLength(1);
});
