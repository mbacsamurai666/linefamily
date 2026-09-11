/**
 * Verifies a LIFF ID token against LINE's own verify endpoint and resolves it
 * to a family member.
 *
 * The token proves who the LINE user is; it says nothing about which family
 * they belong to. Resolution here picks the first family a Member row with
 * that LINE user id exists in. That is a real limitation, not an oversight:
 * a person who is a member of more than one family group gets whichever
 * family was created first. Fine for the common case (one household per
 * person); flagged in the README as something to fix if it ever matters.
 */

export interface VerifiedLiffUser {
  lineUserId: string;
}

export async function verifyLiffIdToken(
  idToken: string,
  channelId: string,
): Promise<VerifiedLiffUser | null> {
  if (idToken.length === 0 || channelId.length === 0) return null;

  let res: Response;
  try {
    res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = (await res.json().catch(() => null)) as { sub?: string } | null;
  if (!data?.sub) return null;

  return { lineUserId: data.sub };
}
