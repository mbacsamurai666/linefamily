import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

/**
 * The family's calendar as a feed a phone can subscribe to.
 *
 * The token in the URL is the whole credential — anyone holding it reads the
 * calendar — so it is made once and kept, and `reset` is how a link that went
 * somewhere it should not is taken back. The API route and the chat command
 * both hand out the same link from here.
 */

export interface CalendarLink {
  /** https://… — what Google Calendar's "from URL" wants. */
  url: string;
  /** webcal://… — what a phone's calendar app opens as a subscription. */
  webcalUrl: string;
}

export async function calendarLink(
  prisma: PrismaClient,
  familyId: string,
  publicBaseUrl: string,
  reset = false,
): Promise<CalendarLink> {
  const family = await prisma.family.findUniqueOrThrow({
    where: { id: familyId },
    select: { calendarToken: true },
  });
  const token =
    family.calendarToken && !reset
      ? family.calendarToken
      : (
          await prisma.family.update({
            where: { id: familyId },
            data: { calendarToken: randomBytes(24).toString('base64url') },
            select: { calendarToken: true },
          })
        ).calendarToken;

  const base = publicBaseUrl.replace(/\/+$/, '');
  return {
    url: `${base}/calendar/${token}.ics`,
    webcalUrl: `${base.replace(/^https?:/, 'webcal:')}/calendar/${token}.ics`,
  };
}
