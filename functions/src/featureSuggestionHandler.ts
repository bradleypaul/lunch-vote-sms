import { FieldValue } from "firebase-admin/firestore";
import { COLLECTIONS, MY_PHONE_NUMBER } from "./config";
import { isSuggestionsCommand } from "./voteParsing";
import { sendMessage } from "./gatewayClient";

interface FeatureSuggestionDoc {
  suggestion: string;
  proposerPhoneHash: string;
}

/**
 * Records a confident classifyFeatureSuggestion match and texts the owner
 * immediately — unlike activity ideas, there's no response window to
 * batch here, since feature feedback isn't something other members need
 * to weigh in on. The proposer's identity never goes out in the
 * notification text, same anonymity treatment as everywhere else (see
 * README "Design note on phone numbers").
 */
export async function handleFeatureSuggestion(
  db: FirebaseFirestore.Firestore,
  proposerPhoneHash: string,
  suggestion: string
): Promise<void> {
  const ref = db.collection(COLLECTIONS.featureSuggestions).doc();
  await ref.set({
    suggestion,
    proposerPhoneHash,
    createdAt: FieldValue.serverTimestamp(),
  });
  console.log(`featureSuggestionHandler: recorded id=${ref.id}`);

  try {
    await sendMessage(MY_PHONE_NUMBER.value(), `New feature suggestion: "${suggestion}"`);
  } catch (err) {
    console.error(`featureSuggestionHandler: owner notice send failed id=${ref.id}`, err);
  }
}

/** Texts `replyTo` every recorded feature suggestion, most recent first. */
export async function listFeatureSuggestions(db: FirebaseFirestore.Firestore, replyTo: string): Promise<void> {
  const snap = await db.collection(COLLECTIONS.featureSuggestions).orderBy("createdAt", "desc").get();
  const lines = snap.docs.map((doc, i) => `${i + 1}. ${(doc.data() as FeatureSuggestionDoc).suggestion}`);

  const text = lines.length > 0 ? `Feature suggestions:\n${lines.join("\n")}` : "No feature suggestions yet.";
  try {
    await sendMessage(replyTo, text);
  } catch (err) {
    console.error("featureSuggestionHandler: list send failed", err);
  }
}

/** Fast path: handles an admin's exact "suggestions" syntax, free and instant. */
export async function handleSuggestionsCommand(db: FirebaseFirestore.Firestore, message: string, replyTo: string): Promise<boolean> {
  if (!isSuggestionsCommand(message)) {
    return false;
  }
  await listFeatureSuggestions(db, replyTo);
  return true;
}
