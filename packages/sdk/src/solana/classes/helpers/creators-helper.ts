import { CreatorInput } from "../../types/contracts";
import type { Creator } from "@metaplex-foundation/js";
import { PublicKey } from "@solana/web3.js";

/**
 * @internal
 */
export function enforceCreator(
  creators: CreatorInput[] = [],
  owner: PublicKey,
): Creator[] {
  if (creators.length === 0) {
    // If no creators are specified, we assume the owner is the creator
    creators = creators.concat({
      address: owner.toBase58(),
      sharePercentage: 100,
      verified: true,
    });
  }
  return creators.map((creator) => ({
    verified: creator.verified || false,
    address: new PublicKey(creator.address),
    share: creator.sharePercentage,
  }));
}
