import { prisma } from "../src/lib/db";

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, email: true, name: true } });
  console.log("Users:", users);

  const collections = await prisma.collection.findMany({ select: { id: true, name: true, userId: true } });
  console.log("Collections:", collections);

  const items = await prisma.userCollection.findMany({
    include: {
      card: {
        include: { set: true }
      }
    }
  });
  console.log(`Found ${items.length} items in UserCollection:`);
  for (const item of items) {
    console.log({
      id: item.id,
      userId: item.userId,
      cardId: item.cardId,
      cardName: item.card.name,
      externalId: item.card.externalId,
      quantity: item.quantity,
      condition: item.condition,
      isFoil: item.isFoil,
      isSold: item.isSold,
      soldPrice: item.soldPrice,
      purchasePrice: item.purchasePrice,
      collectionId: item.collectionId,
    });
  }
}

main().finally(() => prisma.$disconnect());
