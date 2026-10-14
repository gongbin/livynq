import type { DeviceDTO, Room } from '@livynq/model';
import type { ChatMessage, LlmProvider, ToolSpec } from './llm.ts';
import { INSTRUCTIONS, type Toolbox } from './mcp.ts';

/**
 * Livynq's built-in assistant: a chat loop over the same tools external agents get through MCP
 * (same scopes, risk limits and confirmations), plus a draft_automation tool that only validates
 * and shows an automation — saving it is always the user's click.
 */

export type AssistantEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'toolResult'; id: string; name: string; ok: boolean; pendingConfirmation?: string }
  | { type: 'automation'; config: Record<string, unknown>; warnings: string[] }
  | { type: 'done'; messages: ChatMessage[] }
  | { type: 'error'; message: string };

export interface Validation {
  ok: boolean;
  errors: string[];
  warnings?: string[];
}

export interface AssistantOptions {
  provider: LlmProvider;
  toolbox: Toolbox;
  validateAutomation: (config: unknown) => Validation;
  /** "zh" | "en" — the reply language when the user's message doesn't make it obvious */
  lang?: string;
  timezone?: string;
  now?: Date;
  maxRounds?: number;
  signal?: AbortSignal;
}

const AUTOMATION_FORMAT = `Automations use Home Assistant syntax (no Jinja templates):
{ alias, description?, mode?: single|restart|queued|parallel,
  triggers: [ {trigger: state, entity_id, from?, to?, for?} | {trigger: numeric_state, entity_id, above?, below?, for?} | {trigger: time, at: "HH:MM:SS"} |
              {trigger: time_pattern, hours?, minutes?, seconds?} | {trigger: sun, event: sunrise|sunset, offset?: "-00:30:00"} | {trigger: homeassistant, event: start} | {trigger: webhook, webhook_id} ],
  conditions?: [ {condition: state, entity_id, state} | {condition: numeric_state, entity_id, above?, below?} | {condition: time, after?, before?, weekday?: [mon..sun]} |
                 {condition: sun, after?: sunset|sunrise, before?: sunrise|sunset} | {condition: and|or|not, conditions: [...]} | {condition: trigger, id} ],
  actions: [ {action: <domain>.<service>, target: {entity_id | area_id}, data?} | {delay: "HH:MM:SS"} | {wait_for_trigger: [...], timeout?} | {if: [...], then: [...], else?: [...]} |
             {choose: [{conditions, sequence}], default?} | {repeat: {count|while|until, sequence}} | {parallel: [...]} | {stop: "reason"} ] }
Services: light.turn_on (data: brightness_pct, color_temp_kelvin, transition) / turn_off / toggle; switch.turn_on|turn_off|toggle; homeassistant.turn_on|turn_off|toggle (any light/switch/fan, or a whole area);
cover.open_cover|close_cover|stop_cover|set_cover_position (data: position); climate.set_temperature (data: temperature, hvac_mode?) / set_hvac_mode / turn_on / turn_off;
fan.turn_on|turn_off|set_percentage (data: percentage); lock.lock|unlock; notify.notify (data: title?, message); automation.turn_on|turn_off|trigger.
States: lights/switches "on"/"off"; binary sensors (motion, contact, leak) "on" = detected / open / wet; covers "open"/"closed"; locks "locked"/"unlocked".
Use only entity ids and area ids that exist in this home.`;

const draftTool: ToolSpec = {
  name: 'draft_automation',
  description:
    'Validate an automation and show it to the user as a draft card with Save / Edit buttons. It is NOT saved by this tool. ' +
    'Invalid configs return precise errors: fix them and call again. ' +
    AUTOMATION_FORMAT,
  parameters: { type: 'object', properties: { automation: { type: 'object' } }, required: ['automation'] },
};

function systemPrompt(o: AssistantOptions): string {
  const now = o.now ?? new Date();
  const tz = o.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `You are the assistant built into Livynq, the user's local smart home hub. You can look at and control their home with tools.
Reply in the user's language (default: ${o.lang === 'en' ? 'English' : 'Chinese (简体中文)'}). Be brief and concrete; no markdown tables.
Current time: ${now.toLocaleString('sv-SE', { timeZone: tz })} (${tz}).

${INSTRUCTIONS}

When the user wants something to happen automatically ("every evening…", "when the door opens…"), build an automation and call draft_automation;
never use propose_automation here. Check entity ids with list_devices first. After drafting, explain in one or two sentences what it does.
When an action is pending confirmation, tell the user to approve it in the banner at the top of the app.`;
}

const toToolSpecs = (toolbox: Toolbox): ToolSpec[] =>
  toolbox
    .tools()
    .filter((t) => t.name !== 'propose_automation')
    .map((t) => ({ name: t.name, description: t.description ?? '', parameters: t.inputSchema as Record<string, unknown> }));

/** One user turn: streams text and tool activity; ends with the messages to append to the history. */
export async function* runAssistant(o: AssistantOptions, history: ChatMessage[], userText: string): AsyncGenerator<AssistantEvent> {
  const added: ChatMessage[] = [{ role: 'user', content: userText }];
  const tools = [...toToolSpecs(o.toolbox), draftTool];
  const system = systemPrompt(o);
  try {
    for (let round = 0; round < (o.maxRounds ?? 8); round++) {
      let text = '';
      const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
      for await (const e of o.provider.stream({ system, messages: [...history, ...added], tools, signal: o.signal })) {
        if (e.type === 'text') {
          text += e.text;
          yield e;
        } else if (e.type === 'toolCall') calls.push(e.call);
      }
      added.push({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) });
      if (!calls.length) break;
      for (const call of calls) {
        yield { type: 'tool', id: call.id, name: call.name, args: call.args };
        if (call.name === 'draft_automation') {
          const config = call.args.automation;
          const v = config && typeof config === 'object' && !Array.isArray(config) ? o.validateAutomation(config) : { ok: false, errors: ['automation must be an object'] };
          if (v.ok) yield { type: 'automation', config: config as Record<string, unknown>, warnings: v.warnings ?? [] };
          yield { type: 'toolResult', id: call.id, name: call.name, ok: v.ok };
          added.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: v.ok ? `Shown to the user as a draft${v.warnings?.length ? ` (warnings: ${v.warnings.join('; ')})` : ''}. It is not saved until they press Save.` : `Invalid automation:\n- ${v.errors.join('\n- ')}`,
            ...(v.ok ? {} : { isError: true }),
          });
          continue;
        }
        const result = await o.toolbox.call(call.name, call.args);
        const content = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
        const pending = /"pending_confirmation":\s*"([^"]+)"/.exec(content)?.[1];
        yield { type: 'toolResult', id: call.id, name: call.name, ok: !result.isError, ...(pending ? { pendingConfirmation: pending } : {}) };
        // Keep the context small: long tool outputs are cut.
        added.push({ role: 'tool', toolCallId: call.id, name: call.name, content: content.length > 12_000 ? `${content.slice(0, 12_000)}\n…(truncated)` : content, ...(result.isError ? { isError: true } : {}) });
      }
    }
    yield { type: 'done', messages: added };
  } catch (err) {
    yield { type: 'error', message: (err as Error).message };
    yield { type: 'done', messages: added };
  }
}

// ---------------------------------------------------------------- natural language → automation

/** Compact home description for prompts: rooms (area ids) and entities with their states. */
export function homeContext(rooms: Room[], devices: DeviceDTO[]): string {
  const lines = [`Areas: ${rooms.map((r) => `${r.id} (${r.name}${r.aliases?.length ? `, ${r.aliases.join(', ')}` : ''})`).join('; ') || 'none'}`, 'Entities:'];
  for (const d of devices) {
    if (d.exposure.agent === 'hidden') continue;
    for (const [epId, entityId] of Object.entries(d.entities)) {
      const ep = d.endpoints.find((e) => String(e.id) === epId);
      lines.push(`- ${entityId}: ${d.name}${ep?.name ? ` · ${ep.name}` : ''}${d.roomId ? ` [area ${d.roomId}]` : ''} (${ep?.deviceType ?? ''})`);
    }
  }
  return lines.join('\n');
}

const submitTool: ToolSpec = {
  name: 'submit_automation',
  description: 'Submit the automation config. ' + AUTOMATION_FORMAT,
  parameters: {
    type: 'object',
    properties: { automation: { type: 'object' }, explanation: { type: 'string', description: 'One sentence in the user’s language: what it does' } },
    required: ['automation', 'explanation'],
  },
};

export interface GeneratedAutomation {
  config: Record<string, unknown> | null;
  explanation: string;
  errors: string[];
  warnings: string[];
  attempts: number;
}

/**
 * "Turn on the hallway light when motion is detected after sunset" → a validated automation config.
 * Validation errors go back to the model (up to `attempts` tries). Nothing is saved.
 */
export async function generateAutomation(o: {
  provider: LlmProvider;
  description: string;
  context: string;
  validate: (config: unknown) => Validation;
  current?: Record<string, unknown>;
  lang?: string;
  attempts?: number;
  signal?: AbortSignal;
}): Promise<GeneratedAutomation> {
  const system = `You write Home Assistant style automations for Livynq. Use only the entity ids and area ids listed below.
Always answer by calling submit_automation. Write alias and explanation in ${o.lang === 'en' ? 'English' : 'Chinese (简体中文)'}.

${o.context}`;
  const ask = o.current ? `Change this automation as follows: ${o.description}\n\nCurrent automation:\n${JSON.stringify(o.current, null, 2)}` : o.description;
  const messages: ChatMessage[] = [{ role: 'user', content: ask }];
  let last: GeneratedAutomation = { config: null, explanation: '', errors: ['the model did not return an automation'], warnings: [], attempts: 0 };
  for (let attempt = 1; attempt <= (o.attempts ?? 3); attempt++) {
    let call: { id: string; name: string; args: Record<string, unknown> } | undefined;
    let text = '';
    for await (const e of o.provider.stream({ system, messages, tools: [submitTool], toolChoice: 'submit_automation', temperature: 0, signal: o.signal })) {
      if (e.type === 'toolCall' && e.call.name === 'submit_automation') call = e.call;
      else if (e.type === 'text') text += e.text;
    }
    if (!call) {
      last = { ...last, attempts: attempt, errors: [text.trim() || 'the model did not return an automation'] };
      messages.push({ role: 'assistant', content: text || '…' }, { role: 'user', content: 'Call submit_automation with the automation.' });
      continue;
    }
    const config = call.args.automation;
    const v = config && typeof config === 'object' && !Array.isArray(config) ? o.validate(config) : { ok: false, errors: ['automation must be an object'] };
    last = { config: config && typeof config === 'object' ? (config as Record<string, unknown>) : null, explanation: String(call.args.explanation ?? ''), errors: v.errors, warnings: v.warnings ?? [], attempts: attempt };
    if (v.ok) return last;
    messages.push({ role: 'assistant', content: '', toolCalls: [call] }, { role: 'tool', toolCallId: call.id, name: call.name, content: `Invalid:\n- ${v.errors.join('\n- ')}\nFix it and call submit_automation again.`, isError: true });
  }
  return last;
}
