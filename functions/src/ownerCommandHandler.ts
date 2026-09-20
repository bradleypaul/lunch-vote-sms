import { CLASSIFY_CONFIDENCE_THRESHOLD } from "./config";
import { classifyOwnerIntent } from "./classifyOwnerIntent";
import { safeClassify } from "./safeClassify";
import { createInvite } from "./inviteHandler";
import { createPoll } from "./pollCommandHandler";
import { listMembers, removeMember, setCanHost, setIsAdmin } from "./memberManagementHandler";
import { sendOwnerHelpText } from "./helpHandler";

/**
 * Last-resort interpretation of a message from an admin (the root owner or
 * anyone promoted via "admin <name or phone> yes"), tried only after every
 * exact-syntax fast-path command (help, invite, poll, members, remove,
 * canhost, admin) and the approve/override flow have all failed to match.
 * Runs one Haiku call to figure out intent from natural phrasing, then
 * dispatches to the same underlying actions those fast paths use — so "can
 * you add Jane, her number's 512-555-1234" does exactly what "invite Jane
 * 512-555-1234" does. `replyTo` is always the sender — confirmations go
 * back to whichever admin issued the command, not to a fixed number.
 */
export async function handleOwnerNaturalLanguageFallback(
  db: FirebaseFirestore.Firestore,
  message: string,
  replyTo: string
): Promise<void> {
  const intent = await safeClassify("ownerCommandHandler classifyOwnerIntent", null, () =>
    classifyOwnerIntent(message, CLASSIFY_CONFIDENCE_THRESHOLD)
  );

  if (!intent) {
    console.log("ownerCommandHandler: no match, natural-language fallback included");
    return;
  }

  switch (intent.action) {
    case "invite":
      await createInvite(db, intent.name, intent.phoneNumber, replyTo);
      return;
    case "create_poll":
      await createPoll(db, intent.options, replyTo);
      return;
    case "remove_member":
      await removeMember(db, intent.who, replyTo);
      return;
    case "set_can_host":
      await setCanHost(db, intent.who, intent.canHost, replyTo);
      return;
    case "set_is_admin":
      await setIsAdmin(db, intent.who, intent.isAdmin, replyTo);
      return;
    case "list_members":
      await listMembers(db, replyTo);
      return;
    case "help":
      await sendOwnerHelpText(replyTo);
      return;
  }
}
