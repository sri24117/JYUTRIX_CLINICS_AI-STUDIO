import "dotenv/config";
import { registerKapsoWebhook } from "../src/kapso.js";
import { PUBLIC_URL } from "../src/store.js";

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const clinicId = arg("--clinic-id");
const numberId = arg("--number-id");

if (!clinicId || !numberId) {
  console.error("Usage: npx tsx scripts/register-kapso.ts --clinic-id <ID> --number-id <NUMBER_ID>");
  process.exit(1);
}

const webhookUrl = `${PUBLIC_URL}/webhooks/kapso/${clinicId}`;
console.log(`Registering Kapso Meta webhook for clinic #${clinicId}: ${webhookUrl}`);

registerKapsoWebhook(numberId, webhookUrl)
  .then((res) => {
    console.log(`Status: ${res.status}`, JSON.stringify(res.data, null, 2));
    if (!res.ok) process.exit(1);
  })
  .catch((err) => {
    console.error("Registration failed:", err.message);
    process.exit(1);
  });
