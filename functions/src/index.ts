import * as admin from "firebase-admin";

admin.initializeApp();

export { voteWebhook } from "./voteWebhook";
export { sendAnnouncement } from "./sendAnnouncement";
export { generateDigest } from "./generateDigest";
export { generateIdeaDigest } from "./generateIdeaDigest";
