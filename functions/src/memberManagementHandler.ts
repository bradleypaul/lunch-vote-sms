import { COLLECTIONS, MY_PHONE_NUMBER, hashPhoneNumber } from "./config";
import { isMembersCommand, normalizeText, parseCanHostCommand, parseRemoveCommand } from "./voteParsing";
import { sendMessage } from "./gatewayClient";

interface GroupMemberDoc {
  name: string;
  phoneNumber: string;
  active: boolean;
  canHost?: boolean;
}

/**
 * Resolves the owner's "<name or phone>" identifier to a groupMembers doc.
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

/** Texts the owner a roster of every groupMembers doc and its status. */
export async function listMembers(db: FirebaseFirestore.Firestore): Promise<void> {
  const membersSnap = await db.collection(COLLECTIONS.groupMembers).get();
  const lines = membersSnap.docs.map((doc) => {
    const member = doc.data() as GroupMemberDoc;
    const status = !member.active ? "pending" : member.canHost ? "active, can host" : "active";
    return `${member.name} (${member.phoneNumber}) — ${status}`;
  });

  const text = lines.length > 0 ? `Group members:\n${lines.join("\n")}` : "No group members yet.";
  try {
    await sendMessage(MY_PHONE_NUMBER.value(), text);
  } catch (err) {
    console.error("memberManagementHandler: members list send failed", err);
  }
}

/**
 * Deletes the groupMembers doc matching `who` (name or phone) entirely,
 * rather than just deactivating it, so a later invite for the same person
 * starts clean.
 */
export async function removeMember(db: FirebaseFirestore.Firestore, who: string): Promise<void> {
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
    await sendMessage(MY_PHONE_NUMBER.value(), confirmationText);
  } catch (err) {
    console.error("memberManagementHandler: remove confirmation send failed", err);
  }
}

/**
 * Sets whether the member matching `who` (name or phone) gets asked to
 * host a host_needed activity idea (see activityIdeaHandler).
 */
export async function setCanHost(db: FirebaseFirestore.Firestore, who: string, canHost: boolean): Promise<void> {
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
    await sendMessage(MY_PHONE_NUMBER.value(), confirmationText);
  } catch (err) {
    console.error("memberManagementHandler: canhost confirmation send failed", err);
  }
}

/**
 * Fast path: handles the owner's exact "members" syntax, free and
 * instant. Returns whether the message matched this syntax at all, so
 * voteWebhook's owner command chain knows whether to keep trying other
 * interpretations.
 */
export async function handleMembersCommand(db: FirebaseFirestore.Firestore, message: string): Promise<boolean> {
  if (!isMembersCommand(message)) {
    return false;
  }
  await listMembers(db);
  return true;
}

/** Fast path: handles the owner's exact "remove <name or phone>" syntax. */
export async function handleRemoveCommand(db: FirebaseFirestore.Firestore, message: string): Promise<boolean> {
  const command = parseRemoveCommand(message);
  if (!command) {
    return false;
  }
  await removeMember(db, command.who);
  return true;
}

/** Fast path: handles the owner's exact "canhost <name or phone> yes|no" syntax. */
export async function handleCanHostCommand(db: FirebaseFirestore.Firestore, message: string): Promise<boolean> {
  const command = parseCanHostCommand(message);
  if (!command) {
    return false;
  }
  await setCanHost(db, command.who, command.canHost);
  return true;
}
