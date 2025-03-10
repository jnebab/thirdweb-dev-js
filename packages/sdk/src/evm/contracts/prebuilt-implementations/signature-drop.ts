import { NFT, NFTMetadata, NFTMetadataOrUri } from "../../../core/schema/nft";
import { getRoleHash } from "../../common";
import { FEATURE_NFT_REVEALABLE } from "../../constants/erc721-features";
import { TransactionTask } from "../../core/classes/TransactionTask";
import { ContractEncoder } from "../../core/classes/contract-encoder";
import { ContractEvents } from "../../core/classes/contract-events";
import { ContractInterceptor } from "../../core/classes/contract-interceptor";
import { ContractMetadata } from "../../core/classes/contract-metadata";
import { ContractOwner } from "../../core/classes/contract-owner";
import { ContractPlatformFee } from "../../core/classes/contract-platform-fee";
import { ContractRoles } from "../../core/classes/contract-roles";
import { ContractRoyalty } from "../../core/classes/contract-royalty";
import { ContractPrimarySale } from "../../core/classes/contract-sales";
import { ContractWrapper } from "../../core/classes/contract-wrapper";
import { DelayedReveal } from "../../core/classes/delayed-reveal";
import { DropClaimConditions } from "../../core/classes/drop-claim-conditions";
import { Erc721 } from "../../core/classes/erc-721";
import { StandardErc721 } from "../../core/classes/erc-721-standard";
import { Erc721WithQuantitySignatureMintable } from "../../core/classes/erc-721-with-quantity-signature-mintable";
import { GasCostEstimator } from "../../core/classes/gas-cost-estimator";
import {
  NetworkOrSignerOrProvider,
  TransactionResult,
  TransactionResultWithId,
} from "../../core/types";
import { PaperCheckout } from "../../integrations/paper-xyz";
import { DropErc721ContractSchema } from "../../schema/contracts/drop-erc721";
import { SDKOptions } from "../../schema/sdk-options";
import { ClaimOptions, UploadProgressEvent } from "../../types";
import {
  DEFAULT_QUERY_ALL_COUNT,
  QueryAllParams,
} from "../../types/QueryParams";
import type { SignatureDrop as SignatureDropContract } from "@thirdweb-dev/contracts-js";
import type ABI from "@thirdweb-dev/contracts-js/dist/abis/SignatureDrop.json";
import { ThirdwebStorage } from "@thirdweb-dev/storage";
import { BigNumber, BigNumberish, CallOverrides, constants } from "ethers";

/**
 * Setup a collection of NFTs where when it comes to minting, you can authorize
 * some external party to mint tokens on your contract, and specify what exactly
 * will be minted by that external party..
 *
 * @example
 *
 * ```javascript
 * import { ThirdwebSDK } from "@thirdweb-dev/sdk";
 *
 * const sdk = new ThirdwebSDK("{{chainName}}");
 * const contract = sdk.getSignatureDrop("{{contract_address}}");
 * ```
 *
 * @public
 */
export class SignatureDrop extends StandardErc721<SignatureDropContract> {
  static contractRoles = ["admin", "minter", "transfer"] as const;

  public abi: typeof ABI;
  public erc721: Erc721<SignatureDropContract>;
  public owner: ContractOwner<SignatureDropContract>;
  public encoder: ContractEncoder<SignatureDropContract>;
  public estimator: GasCostEstimator<SignatureDropContract>;
  public metadata: ContractMetadata<
    SignatureDropContract,
    typeof DropErc721ContractSchema
  >;
  public sales: ContractPrimarySale<SignatureDropContract>;
  public platformFees: ContractPlatformFee<SignatureDropContract>;
  public events: ContractEvents<SignatureDropContract>;
  public roles: ContractRoles<
    SignatureDropContract,
    typeof SignatureDrop.contractRoles[number]
  >;
  /**
   * @internal
   */
  public interceptor: ContractInterceptor<SignatureDropContract>;
  /**
   * Configure royalties
   * @remarks Set your own royalties for the entire contract or per token
   * @example
   * ```javascript
   * // royalties on the whole contract
   * contract.royalties.setDefaultRoyaltyInfo({
   *   seller_fee_basis_points: 100, // 1%
   *   fee_recipient: "0x..."
   * });
   * // override royalty for a particular token
   * contract.royalties.setTokenRoyaltyInfo(tokenId, {
   *   seller_fee_basis_points: 500, // 5%
   *   fee_recipient: "0x..."
   * });
   * ```
   */
  public royalties: ContractRoyalty<
    SignatureDropContract,
    typeof DropErc721ContractSchema
  >;
  /**
   * Configure claim conditions
   * @remarks Define who can claim NFTs in the collection, when and how many.
   * @example
   * ```javascript
   * const presaleStartTime = new Date();
   * const claimCondition = {
   *     startTime: presaleStartTime, // start the presale now
   *     maxQuantity: 2, // limit how many mints for this presale
   *     price: 0.01, // presale price
   *     snapshot: ['0x...', '0x...'], // limit minting to only certain addresses
   * };
   * await contract.claimConditions.set([claimCondition]);
   * ```
   */
  public claimConditions: DropClaimConditions<SignatureDropContract>;
  /**
   * Delayed reveal
   * @remarks Create a batch of encrypted NFTs that can be revealed at a later time.
   * @example
   * ```javascript
   * // the real NFTs, these will be encrypted until you reveal them
   * const realNFTs = [{
   *   name: "Common NFT #1",
   *   description: "Common NFT, one of many.",
   *   image: fs.readFileSync("path/to/image.png"),
   * }, {
   *   name: "Super Rare NFT #2",
   *   description: "You got a Super Rare NFT!",
   *   image: fs.readFileSync("path/to/image.png"),
   * }];
   * // A placeholder NFT that people will get immediately in their wallet, and will be converted to the real NFT at reveal time
   * const placeholderNFT = {
   *   name: "Hidden NFT",
   *   description: "Will be revealed next week!"
   * };
   * // Create and encrypt the NFTs
   * await contract.revealer.createDelayedRevealBatch(
   *   placeholderNFT,
   *   realNFTs,
   *   "my secret password",
   * );
   * // Whenever you're ready, reveal your NFTs at any time
   * const batchId = 0; // the batch to reveal
   * await contract.revealer.reveal(batchId, "my secret password");
   * ```
   */
  public revealer: DelayedReveal<SignatureDropContract>;
  /**
   * Signature Minting
   * @remarks Generate dynamic NFTs with your own signature, and let others mint them using that signature.
   * @example
   * ```javascript
   * // see how to craft a payload to sign in the `contract.signature.generate()` documentation
   * const signedPayload = contract.signature.generate(payload);
   *
   * // now anyone can mint the NFT
   * const tx = contract.signature.mint(signedPayload);
   * const receipt = tx.receipt; // the mint transaction receipt
   * const mintedId = tx.id; // the id of the NFT minted
   * ```
   */
  public signature: Erc721WithQuantitySignatureMintable;

  /**
   * Checkout
   * @remarks Create a FIAT currency checkout for your NFT drop.
   */
  public checkout: PaperCheckout<SignatureDropContract>;

  constructor(
    network: NetworkOrSignerOrProvider,
    address: string,
    storage: ThirdwebStorage,
    options: SDKOptions = {},
    abi: typeof ABI,
    contractWrapper = new ContractWrapper<SignatureDropContract>(
      network,
      address,
      abi,
      options,
    ),
  ) {
    super(contractWrapper, storage);
    this.abi = abi;
    this.metadata = new ContractMetadata(
      this.contractWrapper,
      DropErc721ContractSchema,
      this.storage,
    );
    this.roles = new ContractRoles(
      this.contractWrapper,
      SignatureDrop.contractRoles,
    );
    this.royalties = new ContractRoyalty(this.contractWrapper, this.metadata);
    this.sales = new ContractPrimarySale(this.contractWrapper);
    this.encoder = new ContractEncoder(this.contractWrapper);
    this.estimator = new GasCostEstimator(this.contractWrapper);
    this.events = new ContractEvents(this.contractWrapper);
    this.platformFees = new ContractPlatformFee(this.contractWrapper);
    this.interceptor = new ContractInterceptor(this.contractWrapper);
    this.erc721 = new Erc721(this.contractWrapper, this.storage);
    this.claimConditions = new DropClaimConditions(
      this.contractWrapper,
      this.metadata,
      this.storage,
    );
    this.signature = new Erc721WithQuantitySignatureMintable(
      this.contractWrapper,
      this.storage,
    );
    this.revealer = new DelayedReveal(
      this.contractWrapper,
      this.storage,
      FEATURE_NFT_REVEALABLE.name,
      () => this.erc721.nextTokenIdToMint(),
    );
    this.signature = new Erc721WithQuantitySignatureMintable(
      this.contractWrapper,
      this.storage,
    );
    this.owner = new ContractOwner(this.contractWrapper);

    this.checkout = new PaperCheckout(this.contractWrapper);
  }

  /**
   * @internal
   */
  onNetworkUpdated(network: NetworkOrSignerOrProvider): void {
    this.contractWrapper.updateSignerOrProvider(network);
  }

  getAddress(): string {
    return this.contractWrapper.readContract.address;
  }

  /** ******************************
   * READ FUNCTIONS
   *******************************/

  /**
   * Get the total count NFTs in this drop contract, both claimed and unclaimed
   */
  override async totalSupply() {
    const claimed = await this.totalClaimedSupply();
    const unclaimed = await this.totalUnclaimedSupply();
    return claimed.add(unclaimed);
  }

  /**
   * Get All Claimed NFTs
   *
   * @remarks Fetch all the NFTs (and their owners) that have been claimed in this Drop.
   *
   * * @example
   * ```javascript
   * const claimedNFTs = await contract.getAllClaimed();
   * const firstOwner = claimedNFTs[0].owner;
   * ```
   *
   * @param queryParams - optional filtering to only fetch a subset of results.
   * @returns The NFT metadata and their ownersfor all NFTs queried.
   */
  public async getAllClaimed(queryParams?: QueryAllParams): Promise<NFT[]> {
    const start = BigNumber.from(queryParams?.start || 0).toNumber();
    const count = BigNumber.from(
      queryParams?.count || DEFAULT_QUERY_ALL_COUNT,
    ).toNumber();
    const maxId = Math.min(
      (await this.totalClaimedSupply()).toNumber(),
      start + count,
    );
    return await Promise.all(
      Array.from(Array(maxId).keys()).map((i) => this.get(i.toString())),
    );
  }

  /**
   * Get All Unclaimed NFTs
   *
   * @remarks Fetch all the NFTs that have been not been claimed yet in this Drop.
   *
   * * @example
   * ```javascript
   * const unclaimedNFTs = await contract.getAllUnclaimed();
   * const firstUnclaimedNFT = unclaimedNFTs[0].name;
   * ```
   *
   * @param queryParams - optional filtering to only fetch a subset of results.
   * @returns The NFT metadata for all NFTs queried.
   */
  public async getAllUnclaimed(
    queryParams?: QueryAllParams,
  ): Promise<NFTMetadata[]> {
    const start = BigNumber.from(queryParams?.start || 0).toNumber();
    const count = BigNumber.from(
      queryParams?.count || DEFAULT_QUERY_ALL_COUNT,
    ).toNumber();
    const firstTokenId = BigNumber.from(
      Math.max((await this.totalClaimedSupply()).toNumber(), start),
    );
    const maxId = BigNumber.from(
      Math.min(
        (
          await this.contractWrapper.readContract.nextTokenIdToMint()
        ).toNumber(),
        firstTokenId.toNumber() + count,
      ),
    );

    return await Promise.all(
      Array.from(Array(maxId.sub(firstTokenId).toNumber()).keys()).map((i) =>
        this.erc721.getTokenMetadata(firstTokenId.add(i).toString()),
      ),
    );
  }

  /**
   * Get the claimed supply
   *
   * @remarks Get the number of claimed NFTs in this Drop.
   *
   * * @example
   * ```javascript
   * const claimedNFTCount = await contract.totalClaimedSupply();
   * console.log(`NFTs claimed so far: ${claimedNFTCount}`);
   * ```
   * @returns the claimed supply
   */
  public async totalClaimedSupply(): Promise<BigNumber> {
    return await this.contractWrapper.readContract.totalMinted();
  }

  /**
   * Get the unclaimed supply
   *
   * @remarks Get the number of unclaimed NFTs in this Drop.
   *
   * * @example
   * ```javascript
   * const unclaimedNFTCount = await contract.totalUnclaimedSupply();
   * console.log(`NFTs left to claim: ${unclaimedNFTCount}`);
   * ```
   * @returns the unclaimed supply
   */
  public async totalUnclaimedSupply(): Promise<BigNumber> {
    const maxSupply =
      await this.contractWrapper.readContract.nextTokenIdToMint();

    return maxSupply.sub(await this.totalClaimedSupply());
  }

  /**
   * Get whether users can transfer NFTs from this contract
   */
  public async isTransferRestricted(): Promise<boolean> {
    const anyoneCanTransfer = await this.contractWrapper.readContract.hasRole(
      getRoleHash("transfer"),
      constants.AddressZero,
    );
    return !anyoneCanTransfer;
  }

  /** ******************************
   * WRITE FUNCTIONS
   *******************************/

  /**
   * Create a batch of unique NFTs to be claimed in the future
   *
   * @remarks Create batch allows you to create a batch of many unique NFTs in one transaction.
   *
   * @example
   * ```javascript
   * // Custom metadata of the NFTs to create
   * const metadatas = [{
   *   name: "Cool NFT",
   *   description: "This is a cool NFT",
   *   image: fs.readFileSync("path/to/image.png"), // This can be an image url or file
   * }, {
   *   name: "Cool NFT",
   *   description: "This is a cool NFT",
   *   image: fs.readFileSync("path/to/image.png"),
   * }];
   *
   * const results = await contract.createBatch(metadatas); // uploads and creates the NFTs on chain
   * const firstTokenId = results[0].id; // token id of the first created NFT
   * const firstNFT = await results[0].data(); // (optional) fetch details of the first created NFT
   * ```
   *
   * @param metadatas - The metadata to include in the batch.
   * @param options - optional upload progress callback
   */
  public async createBatch(
    metadatas: NFTMetadataOrUri[],
    options?: {
      onProgress: (event: UploadProgressEvent) => void;
    },
  ): Promise<TransactionResultWithId<NFTMetadata>[]> {
    return this.erc721.lazyMint(metadatas, options);
  }

  /**
   * Construct a claim transaction without executing it.
   * This is useful for estimating the gas cost of a claim transaction, overriding transaction options and having fine grained control over the transaction execution.
   * @param destinationAddress
   * @param quantity
   * @param checkERC20Allowance
   */
  public async getClaimTransaction(
    destinationAddress: string,
    quantity: BigNumberish,
    options?: ClaimOptions,
  ): Promise<TransactionTask> {
    return this.erc721.getClaimTransaction(
      destinationAddress,
      quantity,
      options,
    );
  }

  /**
   * Claim unique NFTs to a specific Wallet
   *
   * @remarks Let the specified wallet claim NFTs.
   *
   * @example
   * ```javascript
   * const address = "{{wallet_address}}"; // address of the wallet you want to claim the NFTs
   * const quantity = 1; // how many unique NFTs you want to claim
   *
   * const tx = await contract.claimTo(address, quantity);
   * const receipt = tx.receipt; // the transaction receipt
   * const claimedTokenId = tx.id; // the id of the NFT claimed
   * const claimedNFT = await tx.data(); // (optional) get the claimed NFT metadata
   * ```
   *
   * @param destinationAddress - Address you want to send the token to
   * @param quantity - Quantity of the tokens you want to claim
   * @param checkERC20Allowance - Optional, check if the wallet has enough ERC20 allowance to claim the tokens, and if not, approve the transfer
   *
   * @returns - an array of results containing the id of the token claimed, the transaction receipt and a promise to optionally fetch the nft metadata
   */
  public async claimTo(
    destinationAddress: string,
    quantity: BigNumberish,
    options?: ClaimOptions,
  ): Promise<TransactionResultWithId<NFT>[]> {
    return this.erc721.claimTo(destinationAddress, quantity, options);
  }

  /**
   * Claim NFTs to the connected wallet.
   *
   * @remarks See {@link NFTDrop.claimTo}
   *
   * @returns - an array of results containing the id of the token claimed, the transaction receipt and a promise to optionally fetch the nft metadata
   */
  public async claim(
    quantity: BigNumberish,
    options?: ClaimOptions,
  ): Promise<TransactionResultWithId<NFT>[]> {
    return this.erc721.claim(quantity, options);
  }

  /**
   * Burn a single NFT
   * @param tokenId - the token Id to burn
   * @example
   * ```javascript
   * const result = await contract.burnToken(tokenId);
   * ```
   */
  public async burn(tokenId: BigNumberish): Promise<TransactionResult> {
    return this.erc721.burn(tokenId);
  }

  /**
   * @internal
   */
  public async call(
    functionName: string,
    ...args: unknown[] | [...unknown[], CallOverrides]
  ): Promise<any> {
    return this.contractWrapper.call(functionName, ...args);
  }
}
