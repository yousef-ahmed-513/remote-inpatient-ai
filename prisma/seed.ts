// Loads the synthetic demo dataset:  npm run db:seed
// (The app also seeds itself automatically on first request if the database is empty.)
import { prisma } from "../src/lib/db";
import { seedDatabase } from "../src/lib/seed";

seedDatabase()
  .then(async () => {
    const [patients, readings] = await Promise.all([prisma.patient.count(), prisma.reading.count()]);
    console.log(`Seeded ${patients} synthetic patients and ${readings} historical readings.`);
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
