import { auditAttachmentStorage } from "../dist/storage/attachments.js";
import { db } from "../dist/storage/db.js";

try {
    const result = await auditAttachmentStorage();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
} finally {
    await db.end();
}
