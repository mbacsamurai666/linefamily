import type { messagingApi } from '@line/bot-sdk';
import type { ReminderJob } from '../reminders/ports.js';

/**
 * The buttons under a digest: one tap where there used to be a command to type.
 *
 * A digest that says "ยาความดัน 08:00" and then waits for someone to type
 * "กินยาแล้ว" is asking twice. LINE quick replies put the reply under the
 * message, and each one sends exactly the text a person would have typed —
 * so tapping "จ่ายแล้ว ค่าไฟ" is the same "จ่ายบิลแล้ว ค่าไฟ" the chat
 * command already handles, checks and answers. Nothing here writes anything;
 * it only saves the typing.
 *
 * LINE's limits: 13 items, labels of 20 characters. The order below is the
 * order of urgency — a dose is worth more than a chore.
 */

/** Names for the rows the jobs point at, keyed by refId. */
export interface DigestNames {
  bills: Map<string, string>;
  tasks: Map<string, string>;
  chores: Map<string, string>;
}

const MAX_ITEMS = 13;
const LABEL_MAX = 20;

/** LINE cuts labels at 20 characters; cut them ourselves with an ellipsis instead. */
export function fitLabel(text: string): string {
  const chars = [...text];
  return chars.length <= LABEL_MAX ? text : `${chars.slice(0, LABEL_MAX - 1).join('')}…`;
}

function message(label: string, text: string): messagingApi.QuickReplyItem {
  return { type: 'action', action: { type: 'message', label: fitLabel(label), text } };
}

/** Same referent once, however many reminders it produced this round. */
function uniqueRefs(jobs: ReminderJob[], kind: ReminderJob['kind']): string[] {
  return [...new Set(jobs.filter((j) => j.kind === kind).map((j) => j.refId))];
}

export function buildDigestQuickReply(
  jobs: ReminderJob[],
  names: DigestNames,
  liffUrl?: string,
): messagingApi.QuickReply | undefined {
  const items: messagingApi.QuickReplyItem[] = [];

  // "กินยาแล้ว" with no name marks the nearest pending dose of whoever tapped,
  // which is the right thing for one person's medication and the only thing
  // that works without knowing who is holding the phone.
  if (jobs.some((j) => j.kind === 'MEDICATION')) {
    items.push(message('💊 กินยาแล้ว', 'กินยาแล้ว'));
  }

  const choreIds = uniqueRefs(jobs, 'CHORE');
  if (choreIds.length === 1) {
    items.push(message('🧹 ทำแล้ว', 'ทำแล้ว'));
  } else {
    for (const id of choreIds) {
      const name = names.chores.get(id);
      if (name) items.push(message(`🧹 ${name}`, `ทำแล้ว ${name}`));
    }
  }

  for (const id of uniqueRefs(jobs, 'BILL')) {
    const name = names.bills.get(id);
    if (name) items.push(message(`💸 จ่ายแล้ว ${name}`, `จ่ายบิลแล้ว ${name}`));
  }

  for (const id of uniqueRefs(jobs, 'TASK')) {
    const name = names.tasks.get(id);
    if (name) items.push(message(`✅ ${name}`, `ปิดงาน ${name}`));
  }

  if (items.length === 0 && !liffUrl) return undefined;

  const trimmed = items.slice(0, liffUrl ? MAX_ITEMS - 1 : MAX_ITEMS);
  if (liffUrl) {
    trimmed.push({ type: 'action', action: { type: 'uri', label: '🏠 เปิดแอป', uri: liffUrl } });
  }
  return { items: trimmed };
}

/** The one button an escalated dose needs. */
export function buildUrgentQuickReply(job: ReminderJob): messagingApi.QuickReply | undefined {
  if (job.kind !== 'MEDICATION') return undefined;
  return { items: [message('💊 กินยาแล้ว', 'กินยาแล้ว')] };
}
