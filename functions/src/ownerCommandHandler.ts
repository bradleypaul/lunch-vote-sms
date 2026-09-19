import { CLASSIFY_CONFIDENCE_THRESHOLD } from "./config";
import { classifyOwnerIntent } from "./classifyOwnerIntent";
import { safeClassify } from "./safeClassify";
import { createInvite } from "./inviteHandler";
import { createPoll } from "./pollCommandHandler";
import { listMembers, removeMember, setCanHost } from "./memberManagementHandler";
import { sendOwnerHelpText } from "./helpHandler";

/**
 * Last-resort interpretation of a message from the owner's own number,
 * tried only after every exact-syntax fast-path command (help, invite,
 * poll, members, remove, canhost) and the approve/override flow have all
 * failed to match. Runs one Haiku call to figure out intent from natural
 * phrasing, then dispatches to the same underlying actions those fast
 * paths use — so "can you add Jane, her number's 512-555-1234" does
 * exactly what "invite Jane 512-555-1234" does.
 */
export async function handleOwnerNaturalLanguageFallback(db: FirebaseFirestore.Firestore, message: string): Promise<void> {
  const intent = await safeClassify("ownerCommandHandler classifyOwnerIntent", null, () =>
    classifyOwnerIntent(message, CLASSIFY_CONFIDENCE_THRESHOLD)
  );

  if (!intent) {
    console.log("ownerCommandHandler: no match, natural-language fallback included");
    return;
  }

  switch (intent.action) {
    case "invite":
      await createInvite(db, intent.name, intent.phoneNumber);
      return;
    case "create_poll":
      await createPoll(db, intent.options);
      return;
    case "remove_member":
      await removeMember(db, intent.who);
      return;
    case "set_can_host":
      await setCanHost(db, intent.who, intent.canHost);
      return;
    case "list_members":
      await listMembers(db);
      return;
    case "help":
      await sendOwnerHelpText();
      return;
  }
}
