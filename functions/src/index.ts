import * as admin from "firebase-admin";

admin.initializeApp();

export { voteWebhook } from "./voteWebhook";
export { sendAnnouncement } from "./sendAnnouncement";
export { sendVoteReminder } from "./sendVoteReminder";
export { generateDigest } from "./generateDigest";
export { sendApprovalReminder } from "./sendApprovalReminder";
export { generateIdeaDigest } from "./generateIdeaDigest";
