import { COLLECTIONS, hashPhoneNumber } from "./config";
import { isMembersCommand, normalizeText, parseAdminCommand, parseCanHostCommand, parseRemoveCommand } from "./voteParsing";
import { sendMessage } from "./gatewayClient";

interface GroupMemberDoc {
  name: string;
  phoneNumber: string;
  active: boolean;
  canHost?: boolean;
  isAdmin?: boolean;
}

/**
 * Resolves an admin's "<name or phone>" identifier to a groupMembers doc.
 * A 10/11-digit identifier is looked up directly by phoneHash (the doc
 * ID); anything else is matched case-insensitively against every
 * member's name — fine for a 10-25 person group, not worth a query for.
 */
async function findMemberRef(
  db: FirebaseFirestore.Firestore,
  identifier: string
): Promise<FirebaseFirestore.DocumentReference | null> {
  const digits = identifier.replace(/[^\d]/g, "");
  if (digits.length === 10 || digits.length === 11) {
    const ref = db.collection(COLLECTIONS.groupMembers).doc(hashPhoneNumber(identifier));
    const snap = await ref.get();
    return snap.exists ? ref : null;
  }

  const normalizedIdentifier = normalizeText(identifier);
  const membersSnap = await db.collection(COLLECTIONS.groupMembers).get();
  const match = membersSnap.docs.find((doc) => normalizeText((doc.data() as GroupMemberDoc).name ?? "") === normalizedIdentifier);
  return match?.ref ?? null;
}

function memberStatus(member: GroupMemberDoc): string {
  if (!member.active) {
    return "pending";
  }
  const traits = [member.canHost ? "can host" : null, member.isAdmin ? "admin" : null].filter(Boolean);
  return traits.length > 0 ? `active, ${traits.join(", ")}` : "active";
}

/**
 * Texts `replyTo` (whichever admin issued the command) a roster of every
 * groupMembers doc and its status.
 */
export async function listMembers(db: FirebaseFirestore.Firestore, replyTo: string): Promise<void> {
  const membersSnap = await db.collection(COLLECTIONS.groupMembers).get();
  const lines = membersSnap.docs.map((doc) => {
    const member = doc.data() as GroupMemberDoc;
    return `${member.name} (${member.phoneNumber}) — ${memberStatus(member)}`;
  });

  const text = lines.length > 0 ? `Group members:\n${lines.join("\n")}` : "No group members yet.";
  try {
    await sendMessage(replyTo, text);
  } catch (err) {
    console.error("memberManagementHandler: members list send failed", err);
  }
}

/**
 * Deletes the groupMembers doc matching `who` (name or phone) entirely,
 * rather than just deactivating it, so a later invite for the same person
 * starts clean. Confirms back to `replyTo`, the admin who issued this.
 */
export async function removeMember(db: FirebaseFirestore.Firestore, who: string, replyTo: string): Promise<void> {
  const ref = await findMemberRef(db, who);
  let confirmationText: string;
  if (!ref) {
    confirmationText = `Couldn't find a member matching "${who}".`;
  } else {
    const snap = await ref.get();
    const name = (snap.data() as GroupMemberDoc | undefined)?.name ?? who;
    await ref.delete();
    confirmationText = `Removed ${name}.`;
    console.log(`memberManagementHandler: removed member id=${ref.id}`);
  }

  try {
    await sendMessage(replyTo, confirmationText);
  } catch (err) {
    console.error("memberManagementHandler: remove confirmation send failed", err);
  }
}

/**
 * Sets whether the member matching `who` (name or phone) gets asked to
 * host a host_needed activity idea (see activityIdeaHandler). Confirms
 * back to `replyTo`, the admin who issued this.
 */
export async function setCanHost(db: FirebaseFirestore.Firestore, who: string, canHost: boolean, replyTo: string): Promise<void> {
  const ref = await findMemberRef(db, who);
  let confirmationText: string;
  if (!ref) {
    confirmationText = `Couldn't find a member matching "${who}".`;
  } else {
    await ref.update({ canHost });
    const snap = await ref.get();
    const name = (snap.data() as GroupMemberDoc | undefined)?.name ?? who;
    confirmationText = `${name} can${canHost ? "" : "not"} host now.`;
    console.log(`memberManagementHandler: set canHost=${canHost} id=${ref.id}`);
  }

  try {
    await sendMessage(replyTo, confirmationText);
  } catch (err) {
    console.error("memberManagementHandler: canhost confirmation send failed", err);
  }
}

/**
 * Promotes or demotes the member matching `who` (name or phone) —
 * `isAdmin: true` routes their future texts through the same admin
 * command chain as the root owner (see voteWebhook.ts), including this
 * command itself: only an existing admin can ever reach this, since it's
 * only wired into the admin-only command chain to begin with. Confirms
 * back to `replyTo`, the admin who issued this.
 */
export async function setIsAdmin(db: FirebaseFirestore.Firestore, who: string, isAdmin: boolean, replyTo: string): Promise<void> {
  const ref = await findMemberRef(db, who);
  let confirmationText: string;
  if (!ref) {
    confirmationText = `Couldn't find a member matching "${who}".`;
  } else {
    await ref.update({ isAdmin });
    const snap = await ref.get();
    const name = (snap.data() as GroupMemberDoc | undefined)?.name ?? who;
    confirmationText = isAdmin ? `${name} is an admin now.` : `${name} is no longer an admin.`;
    console.log(`memberManagementHandler: set isAdmin=${isAdmin} id=${ref.id}`);
  }

  try {
    await sendMessage(replyTo, confirmationText);
  } catch (err) {
    console.error("memberManagementHandler: admin confirmation send failed", err);
  }
}

/**
 * Fast path: handles an admin's exact "members" syntax, free and
 * instant. Returns whether the message matched this syntax at all, so
 * voteWebhook's admin command chain knows whether to keep trying other
 * interpretations.
 */
export async function handleMembersCommand(db: FirebaseFirestore.Firestore, message: string, replyTo: string): Promise<boolean> {
  if (!isMembersCommand(message)) {
    return false;
  }
  await listMembers(db, replyTo);
  return true;
}

/** Fast path: handles an admin's exact "remove <name or phone>" syntax. */
export async function handleRemoveCommand(db: FirebaseFirestore.Firestore, message: string, replyTo: string): Promise<boolean> {
  const command = parseRemoveCommand(message);
  if (!command) {
    return false;
  }
  await removeMember(db, command.who, replyTo);
  return true;
}

/** Fast path: handles an admin's exact "canhost <name or phone> yes|no" syntax. */
export async function handleCanHostCommand(db: FirebaseFirestore.Firestore, message: string, replyTo: string): Promise<boolean> {
  const command = parseCanHostCommand(message);
  if (!command) {
    return false;
  }
  await setCanHost(db, command.who, command.canHost, replyTo);
  return true;
}

/** Fast path: handles an admin's exact "admin <name or phone> yes|no" syntax. */
export async function handleAdminCommand(db: FirebaseFirestore.Firestore, message: string, replyTo: string): Promise<boolean> {
  const command = parseAdminCommand(message);
  if (!command) {
    return false;
  }
  await setIsAdmin(db, command.who, command.isAdmin, replyTo);
  return true;
}
