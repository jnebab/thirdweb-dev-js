import { NFT, NFTMetadata, NFTMetadataOrUri } from "../../../core/schema/nft";
import {
  assertEnabled,
  detectContractFeature,
  ExtensionNotImplementedError,
  hasFunction,
  NotFoundError,
} from "../../common";
import { fetchTokenMetadata } from "../../common/nft";
import {
  FEATURE_EDITION,
  FEATURE_EDITION_BATCH_MINTABLE,
  FEATURE_EDITION_BURNABLE,
  FEATURE_EDITION_LAZY_MINTABLE,
  FEATURE_EDITION_ENUMERABLE,
  FEATURE_EDITION_MINTABLE,
  FEATURE_EDITION_REVEALABLE,
  FEATURE_EDITION_SIGNATURE_MINTABLE,
  FEATURE_EDITION_CLAIMABLE_WITH_CONDITIONS,
  FEATURE_EDITION_CLAIMABLE,
} from "../../constants/erc1155-features";
import { AirdropInputSchema } from "../../schema/contracts/common/airdrop";
import { EditionMetadataOrUri } from "../../schema/tokens/edition";
import { ClaimOptions, QueryAllParams, UploadProgressEvent } from "../../types";
import { AirdropInput } from "../../types/airdrop/airdrop";
import {
  BaseDropERC1155,
  BaseERC1155,
  BaseSignatureMintERC1155,
} from "../../types/eips";
import { DetectableFeature } from "../interfaces/DetectableFeature";
import { UpdateableNetwork } from "../interfaces/contract";
import {
  NetworkOrSignerOrProvider,
  TransactionResult,
  TransactionResultWithId,
} from "../types";
import { TransactionTask } from "./TransactionTask";
import { ContractWrapper } from "./contract-wrapper";
import { Erc1155Burnable } from "./erc-1155-burnable";
import { Erc1155Enumerable } from "./erc-1155-enumerable";
import { Erc1155LazyMintable } from "./erc-1155-lazymintable";
import { Erc1155Mintable } from "./erc-1155-mintable";
import { Erc1155SignatureMintable } from "./erc-1155-signature-mintable";
import type {
  DropERC1155,
  IBurnableERC1155,
  IERC1155Enumerable,
  IMintableERC1155,
  TokenERC1155,
} from "@thirdweb-dev/contracts-js";
import { ThirdwebStorage } from "@thirdweb-dev/storage";
import { BigNumber, BigNumberish, BytesLike, ethers } from "ethers";

/**
 * Standard ERC1155 NFT functions
 * @remarks Basic functionality for a ERC1155 contract that handles IPFS storage for you.
 * @example
 * ```javascript
 * const contract = await sdk.getContract("{{contract_address}}");
 * await contract.erc1155.transfer(walletAddress, tokenId, quantity);
 * ```
 * @public
 */
export class Erc1155<
  T extends DropERC1155 | TokenERC1155 | BaseERC1155 =
    | BaseERC1155
    | BaseSignatureMintERC1155,
> implements UpdateableNetwork, DetectableFeature
{
  featureName = FEATURE_EDITION.name;
  private query: Erc1155Enumerable | undefined;
  private mintable: Erc1155Mintable | undefined;
  private burnable: Erc1155Burnable | undefined;
  private lazyMintable: Erc1155LazyMintable | undefined;
  private signatureMintable: Erc1155SignatureMintable | undefined;

  protected contractWrapper: ContractWrapper<T>;
  protected storage: ThirdwebStorage;

  constructor(contractWrapper: ContractWrapper<T>, storage: ThirdwebStorage) {
    this.contractWrapper = contractWrapper;
    this.storage = storage;
    this.query = this.detectErc1155Enumerable();
    this.mintable = this.detectErc1155Mintable();
    this.burnable = this.detectErc1155Burnable();
    this.lazyMintable = this.detectErc1155LazyMintable();
    this.signatureMintable = this.detectErc1155SignatureMintable();
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

  ////// Standard ERC1155 functions //////

  /**
   * Get a single NFT Metadata
   *
   * @example
   * ```javascript
   * const nft = await contract.erc1155.get(0);
   * ```
   * @param tokenId - the tokenId of the NFT to retrieve
   * @returns The NFT metadata
   * @twfeature ERC1155
   */
  public async get(tokenId: BigNumberish): Promise<NFT> {
    const [supply, metadata] = await Promise.all([
      this.contractWrapper.readContract
        .totalSupply(tokenId)
        .catch(() => BigNumber.from(0)),
      this.getTokenMetadata(tokenId),
    ]);
    return {
      owner: ethers.constants.AddressZero,
      metadata,
      type: "ERC1155",
      supply: supply.toNumber(),
    };
  }

  /**
   * Returns the total supply of a specific token
   * @param tokenId - The token ID to get the total supply of
   * @returns the total supply
   */
  public async totalSupply(tokenId: BigNumberish): Promise<BigNumber> {
    return await this.contractWrapper.readContract.totalSupply(tokenId);
  }

  /**
   * Get NFT Balance
   *
   * @remarks Get a wallets NFT balance (number of NFTs in this contract owned by the wallet).
   *
   * @example
   * ```javascript
   * // Address of the wallet to check NFT balance
   * const walletAddress = "{{wallet_address}}";
   * const tokenId = 0; // Id of the NFT to check
   * const balance = await contract.erc1155.balanceOf(walletAddress, tokenId);
   * ```
   * @twfeature ERC1155
   */
  public async balanceOf(
    address: string,
    tokenId: BigNumberish,
  ): Promise<BigNumber> {
    return await this.contractWrapper.readContract.balanceOf(address, tokenId);
  }

  /**
   * Get NFT Balance for the currently connected wallet
   */
  public async balance(tokenId: BigNumberish): Promise<BigNumber> {
    return await this.balanceOf(
      await this.contractWrapper.getSignerAddress(),
      tokenId,
    );
  }

  /**
   * Get whether this wallet has approved transfers from the given operator
   * @param address - the wallet address
   * @param operator - the operator address
   */
  public async isApproved(address: string, operator: string): Promise<boolean> {
    return await this.contractWrapper.readContract.isApprovedForAll(
      address,
      operator,
    );
  }

  /**
   * Transfer a single NFT
   *
   * @remarks Transfer an NFT from the connected wallet to another wallet.
   *
   * @example
   * ```javascript
   * // Address of the wallet you want to send the NFT to
   * const toAddress = "{{wallet_address}}";
   * const tokenId = "0"; // The token ID of the NFT you want to send
   * const amount = 3; // How many copies of the NFTs to transfer
   * await contract.erc1155.transfer(toAddress, tokenId, amount);
   * ```
   * @twfeature ERC1155
   */
  public async transfer(
    to: string,
    tokenId: BigNumberish,
    amount: BigNumberish,
    data: BytesLike = [0],
  ): Promise<TransactionResult> {
    const from = await this.contractWrapper.getSignerAddress();
    return {
      receipt: await this.contractWrapper.sendTransaction("safeTransferFrom", [
        from,
        to,
        tokenId,
        amount,
        data,
      ]),
    };
  }

  /**
   * Approve or remove operator as an operator for the caller. Operators can call transferFrom or safeTransferFrom for any token owned by the caller.
   * @param operator - the operator's address
   * @param approved - whether to approve or remove
   *
   * @internal
   */
  public async setApprovalForAll(
    operator: string,
    approved: boolean,
  ): Promise<TransactionResult> {
    return {
      receipt: await this.contractWrapper.sendTransaction("setApprovalForAll", [
        operator,
        approved,
      ]),
    };
  }

  /**
   * Airdrop multiple NFTs
   *
   * @remarks Airdrop one or multiple NFTs to the provided wallet addresses.
   *
   * @example
   * ```javascript
   * // The token ID of the NFT you want to airdrop
   * const tokenId = "0";
   * // Array of objects of addresses and quantities to airdrop NFTs to
   * const addresses = [
   *  {
   *    address: "0x...",
   *    quantity: 2,
   *  },
   *  {
   *   address: "0x...",
   *    quantity: 3,
   *  },
   * ];
   * await contract.airdrop(tokenId, addresses);
   *
   * // You can also pass an array of addresses, it will airdrop 1 NFT per address
   * const tokenId = "0";
   * const addresses = [
   *  "0x...", "0x...", "0x...",
   * ]
   * await contract.erc1155.airdrop(tokenId, addresses);
   * ```
   */
  public async airdrop(
    tokenId: BigNumberish,
    addresses: AirdropInput,
    data: BytesLike = [0],
  ): Promise<TransactionResult> {
    const from = await this.contractWrapper.getSignerAddress();

    const balanceOf = await this.balanceOf(from, tokenId);

    const input = AirdropInputSchema.parse(addresses);

    const totalToAirdrop = input.reduce((prev, curr) => {
      return prev + Number(curr?.quantity || 1);
    }, 0);

    if (balanceOf.toNumber() < totalToAirdrop) {
      throw new Error(
        `The caller owns ${balanceOf.toNumber()} NFTs, but wants to airdrop ${totalToAirdrop} NFTs.`,
      );
    }

    const encoded = input.map(({ address: to, quantity }) => {
      return this.contractWrapper.readContract.interface.encodeFunctionData(
        "safeTransferFrom",
        [from, to, tokenId, quantity, data],
      );
    });

    return {
      receipt: await this.contractWrapper.multiCall(encoded),
    };
  }

  /**
   * Return the next available token ID to mint
   * @internal
   */
  public async nextTokenIdToMint(): Promise<BigNumber> {
    if (hasFunction<TokenERC1155>("nextTokenIdToMint", this.contractWrapper)) {
      return await this.contractWrapper.readContract.nextTokenIdToMint();
    } else {
      throw new Error(
        "Contract requires the `nextTokenIdToMint` function available to determine the next token ID to mint",
      );
    }
  }

  ////// ERC1155 Enumerable Extension //////

  /**
   * Get All NFTs
   *
   * @remarks Get all the data associated with every NFT in this contract.
   *
   * By default, returns the first 100 NFTs, use queryParams to fetch more.
   *
   * @example
   * ```javascript
   * const nfts = await contract.erc1155.getAll();
   * ```
   * @param queryParams - optional filtering to only fetch a subset of results.
   * @returns The NFT metadata for all NFTs queried.
   * @twfeature ERC1155Enumerable
   */
  public async getAll(queryParams?: QueryAllParams): Promise<NFT[]> {
    return assertEnabled(this.query, FEATURE_EDITION_ENUMERABLE).all(
      queryParams,
    );
  }

  /**
   * Get the number of NFTs minted
   * @remarks This returns the total number of NFTs minted in this contract, **not** the total supply of a given token.
   *
   * @returns the total number of NFTs minted in this contract
   * @public
   */
  public async totalCount(): Promise<BigNumber> {
    return assertEnabled(this.query, FEATURE_EDITION_ENUMERABLE).totalCount();
  }

  /**
   * Get the supply of token for a given tokenId.
   * @remarks This is **not** the sum of supply of all NFTs in the contract.
   *
   * @returns the total number of NFTs minted in this contract
   * @public
   */
  public async totalCirculatingSupply(
    tokenId: BigNumberish,
  ): Promise<BigNumber> {
    return assertEnabled(
      this.query,
      FEATURE_EDITION_ENUMERABLE,
    ).totalCirculatingSupply(tokenId);
  }

  /**
   * Get Owned NFTs
   *
   * @remarks Get all the data associated with the NFTs owned by a specific wallet.
   *
   * @example
   * ```javascript
   * // Address of the wallet to get the NFTs of
   * const address = "{{wallet_address}}";
   * const nfts = await contract.erc1155.getOwned(address);
   * ```
   *
   * @returns The NFT metadata for all NFTs in the contract.
   * @twfeature ERC1155Enumerable
   */
  public async getOwned(walletAddress?: string): Promise<NFT[]> {
    return assertEnabled(this.query, FEATURE_EDITION_ENUMERABLE).owned(
      walletAddress,
    );
  }

  ////// ERC1155 Mintable Extension //////

  /**
   * Mint an NFT with a limited supply
   *
   * @remarks Mint an NFT with a limited supply to the connected wallet.
   *
   * @example
   * ```javascript
   * // Address of the wallet you want to mint the NFT to
   * const toAddress = "{{wallet_address}}"
   *
   * // Custom metadata of the NFT, note that you can fully customize this metadata with other properties.
   * const metadata = {
   *   name: "Cool NFT",
   *   description: "This is a cool NFT",
   *   image: fs.readFileSync("path/to/image.png"), // This can be an image url or file
   * }
   *
   * const metadataWithSupply = {
   *   metadata,
   *   supply: 1000, // The number of this NFT you want to mint
   * }
   *
   * const tx = await contract.erc1155.mint(toAddress, metadataWithSupply);
   * const receipt = tx.receipt; // the transaction receipt
   * const tokenId = tx.id; // the id of the NFT minted
   * const nft = await tx.data(); // (optional) fetch details of minted NFT
   * ```
   * @twfeature ERC1155Mintable
   */
  public async mint(
    metadataWithSupply: EditionMetadataOrUri,
  ): Promise<TransactionResultWithId<NFT>> {
    return this.mintTo(
      await this.contractWrapper.getSignerAddress(),
      metadataWithSupply,
    );
  }

  /**
   * Mint an NFT with a limited supply
   *
   * @remarks Mint an NFT with a limited supply to a specified wallet.
   *
   * @example
   * ```javascript
   * // Address of the wallet you want to mint the NFT to
   * const toAddress = "{{wallet_address}}"
   *
   * // Custom metadata of the NFT, note that you can fully customize this metadata with other properties.
   * const metadata = {
   *   name: "Cool NFT",
   *   description: "This is a cool NFT",
   *   image: fs.readFileSync("path/to/image.png"), // This can be an image url or file
   * }
   *
   * const metadataWithSupply = {
   *   metadata,
   *   supply: 1000, // The number of this NFT you want to mint
   * }
   *
   * const tx = await contract.erc1155.mintTo(toAddress, metadataWithSupply);
   * const receipt = tx.receipt; // the transaction receipt
   * const tokenId = tx.id; // the id of the NFT minted
   * const nft = await tx.data(); // (optional) fetch details of minted NFT
   * ```
   * @twfeature ERC1155Mintable
   */
  public async mintTo(
    receiver: string,
    metadataWithSupply: EditionMetadataOrUri,
  ): Promise<TransactionResultWithId<NFT>> {
    return assertEnabled(this.mintable, FEATURE_EDITION_MINTABLE).to(
      receiver,
      metadataWithSupply,
    );
  }

  /**
   * Increase the supply of an existing NFT
   * @remarks Increase the supply of an existing NFT and mint it to the connected wallet address
   * @example
   * ```javascript
   * const tokenId = 0;
   * const additionalSupply = 1000;
   * await contract.erc1155.mintAdditionalSupply(tokenId, additionalSupply);
   * ```
   *
   * @param tokenId - the token id of the NFT to increase supply of
   * @param additionalSupply - the additional amount to mint
   * @twfeature ERC1155Mintable
   */
  public async mintAdditionalSupply(
    tokenId: BigNumberish,
    additionalSupply: BigNumberish,
  ): Promise<TransactionResultWithId<NFT>> {
    return assertEnabled(
      this.mintable,
      FEATURE_EDITION_MINTABLE,
    ).additionalSupplyTo(
      await this.contractWrapper.getSignerAddress(),
      tokenId,
      additionalSupply,
    );
  }

  /**
   * Increase the supply of an existing NFT and mint it to a given wallet address
   *
   * @param to - the address to mint to
   * @param tokenId - the token id of the NFT to increase supply of
   * @param additionalSupply - the additional amount to mint
   */
  public async mintAdditionalSupplyTo(
    receiver: string,
    tokenId: BigNumberish,
    additionalSupply: BigNumberish,
  ): Promise<TransactionResultWithId<NFT>> {
    return assertEnabled(
      this.mintable,
      FEATURE_EDITION_MINTABLE,
    ).additionalSupplyTo(receiver, tokenId, additionalSupply);
  }

  ////// ERC1155 BatchMintable Extension //////

  /**
   * Mint Many NFTs with limited supplies
   *
   * @remarks Mint many different NFTs with limited supplies to the connected wallet.
   *
   * @example
   * ```javascript
   * // Custom metadata and supplies of your NFTs
   * const metadataWithSupply = [{
   *   supply: 50, // The number of this NFT you want to mint
   *   metadata: {
   *     name: "Cool NFT #1",
   *     description: "This is a cool NFT",
   *     image: fs.readFileSync("path/to/image.png"), // This can be an image url or file
   *   },
   * }, {
   *   supply: 100,
   *   metadata: {
   *     name: "Cool NFT #2",
   *     description: "This is a cool NFT",
   *     image: fs.readFileSync("path/to/image.png"), // This can be an image url or file
   *   },
   * }];
   *
   * const tx = await contract.erc1155.mintBatch(metadataWithSupply);
   * const receipt = tx[0].receipt; // same transaction receipt for all minted NFTs
   * const firstTokenId = tx[0].id; // token id of the first minted NFT
   * const firstNFT = await tx[0].data(); // (optional) fetch details of the first minted NFT
   * ```
   * @twfeature ERC1155BatchMintable
   */
  public async mintBatch(
    metadataWithSupply: EditionMetadataOrUri[],
  ): Promise<TransactionResultWithId<NFT>[]> {
    return this.mintBatchTo(
      await this.contractWrapper.getSignerAddress(),
      metadataWithSupply,
    );
  }

  /**
   * Mint Many NFTs with limited supplies
   *
   * @remarks Mint many different NFTs with limited supplies to a specified wallet.
   *
   * @example
   * ```javascript
   * // Address of the wallet you want to mint the NFT to
   * const toAddress = "{{wallet_address}}"
   *
   * // Custom metadata and supplies of your NFTs
   * const metadataWithSupply = [{
   *   supply: 50, // The number of this NFT you want to mint
   *   metadata: {
   *     name: "Cool NFT #1",
   *     description: "This is a cool NFT",
   *     image: fs.readFileSync("path/to/image.png"), // This can be an image url or file
   *   },
   * }, {
   *   supply: 100,
   *   metadata: {
   *     name: "Cool NFT #2",
   *     description: "This is a cool NFT",
   *     image: fs.readFileSync("path/to/image.png"), // This can be an image url or file
   *   },
   * }];
   *
   * const tx = await contract.erc1155.mintBatchTo(toAddress, metadataWithSupply);
   * const receipt = tx[0].receipt; // same transaction receipt for all minted NFTs
   * const firstTokenId = tx[0].id; // token id of the first minted NFT
   * const firstNFT = await tx[0].data(); // (optional) fetch details of the first minted NFT
   * ```
   * @twfeature ERC1155BatchMintable
   */
  public async mintBatchTo(
    receiver: string,
    metadataWithSupply: EditionMetadataOrUri[],
  ): Promise<TransactionResultWithId<NFT>[]> {
    return assertEnabled(
      this.mintable?.batch,
      FEATURE_EDITION_BATCH_MINTABLE,
    ).to(receiver, metadataWithSupply);
  }

  ////// ERC1155 Burnable Extension //////

  /**
   * Burn a specified amount of a NFTs
   *
   * @remarks Burn the specified NFTs from the connected wallet
   *
   * @param tokenId - the token Id to burn
   * @param amount - amount to burn
   *
   * @example
   * ```javascript
   * // The token ID to burn NFTs of
   * const tokenId = 0;
   * // The amount of the NFT you want to burn
   * const amount = 2;
   *
   * const result = await contract.erc1155.burn(tokenId, amount);
   * ```
   * @twfeature ERC1155Burnable
   */
  public async burn(
    tokenId: BigNumberish,
    amount: BigNumberish,
  ): Promise<TransactionResult> {
    return assertEnabled(this.burnable, FEATURE_EDITION_BURNABLE).tokens(
      tokenId,
      amount,
    );
  }

  /**
   * Burn a specified amount of a NFTs
   *
   * @remarks Burn the specified NFTs from a specified wallet
   *
   * @param account - the address to burn NFTs from
   * @param tokenId - the tokenId to burn
   * @param amount - amount to burn
   *
   * @example
   * ```javascript
   * // The address of the wallet to burn NFTS from
   * const account = "0x...";
   * // The token ID to burn NFTs of
   * const tokenId = 0;
   * // The amount of this NFT you want to burn
   * const amount = 2;
   *
   * const result = await contract.erc1155.burnFrom(account, tokenId, amount);
   * ```
   * @twfeature ERC1155Burnable
   */
  public async burnFrom(
    account: string,
    tokenId: BigNumberish,
    amount: BigNumberish,
  ): Promise<TransactionResult> {
    return assertEnabled(this.burnable, FEATURE_EDITION_BURNABLE).from(
      account,
      tokenId,
      amount,
    );
  }

  /**
   * Burn a batch of NFTs
   *
   * @remarks Burn the batch NFTs from the connected wallet
   *
   * @param tokenIds - the tokenIds to burn
   * @param amounts - amount of each token to burn
   *
   * @example
   * ```javascript
   * // The token IDs to burn NFTs of
   * const tokenIds = [0, 1];
   * // The amounts of each NFT you want to burn
   * const amounts = [2, 2];
   *
   * const result = await contract.erc1155.burnBatch(tokenIds, amounts);
   * ```
   * @twfeature ERC1155Burnable
   */
  public async burnBatch(
    tokenIds: BigNumberish[],
    amounts: BigNumberish[],
  ): Promise<TransactionResult> {
    return assertEnabled(this.burnable, FEATURE_EDITION_BURNABLE).batch(
      tokenIds,
      amounts,
    );
  }

  /**
   * Burn a batch of NFTs
   *
   * @remarks Burn the batch NFTs from the specified wallet
   *
   * @param account - the address to burn NFTs from
   * @param tokenIds - the tokenIds to burn
   * @param amounts - amount of each token to burn
   *
   * @example
   * ```javascript
   * // The address of the wallet to burn NFTS from
   * const account = "0x...";
   * // The token IDs to burn NFTs of
   * const tokenIds = [0, 1];
   * // The amounts of each NFT you want to burn
   * const amounts = [2, 2];
   *
   * const result = await contract.erc1155.burnBatchFrom(account, tokenIds, amounts);
   * ```
   * @twfeature ERC1155Burnable
   */
  public async burnBatchFrom(
    account: string,
    tokenIds: BigNumberish[],
    amounts: BigNumberish[],
  ): Promise<TransactionResult> {
    return assertEnabled(this.burnable, FEATURE_EDITION_BURNABLE).batchFrom(
      account,
      tokenIds,
      amounts,
    );
  }

  ////// ERC721 LazyMint Extension //////

  /**
   * Create a batch of NFTs to be claimed in the future
   *
   * @remarks Create batch allows you to create a batch of many NFTs in one transaction.
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
   * const results = await contract.erc1155.lazyMint(metadatas); // uploads and creates the NFTs on chain
   * const firstTokenId = results[0].id; // token id of the first created NFT
   * const firstNFT = await results[0].data(); // (optional) fetch details of the first created NFT
   * ```
   *
   * @param metadatas - The metadata to include in the batch.
   * @param options - optional upload progress callback
   * @twfeature ERC1155LazyMintable
   */
  public async lazyMint(
    metadatas: NFTMetadataOrUri[],
    options?: {
      onProgress: (event: UploadProgressEvent) => void;
    },
  ): Promise<TransactionResultWithId<NFTMetadata>[]> {
    return assertEnabled(
      this.lazyMintable,
      FEATURE_EDITION_LAZY_MINTABLE,
    ).lazyMint(metadatas, options);
  }

  ////// ERC1155 Claimable Extension //////

  /**
   * Construct a claim transaction without executing it.
   * This is useful for estimating the gas cost of a claim transaction, overriding transaction options and having fine grained control over the transaction execution.
   * @param destinationAddress - Address you want to send the token to
   * @param tokenId - Id of the token you want to claim
   * @param quantity - Quantity of the tokens you want to claim
   * @param options - Optional claim verification data (e.g. price, currency, etc...)
   */
  public async getClaimTransaction(
    destinationAddress: string,
    tokenId: BigNumberish,
    quantity: BigNumberish,
    options?: ClaimOptions,
  ): Promise<TransactionTask> {
    const claimWithConditions = this.lazyMintable?.claimWithConditions;
    const claim = this.lazyMintable?.claim;
    if (claimWithConditions) {
      return claimWithConditions.getClaimTransaction(
        destinationAddress,
        tokenId,
        quantity,
        options,
      );
    }
    if (claim) {
      return claim.getClaimTransaction(
        destinationAddress,
        tokenId,
        quantity,
        options,
      );
    }
    throw new ExtensionNotImplementedError(FEATURE_EDITION_CLAIMABLE);
  }

  /**
   * Claim NFTs
   *
   * @remarks Let the connected wallet claim NFTs.
   *
   * @example
   * ```javascript
   * const tokenId = 0; // the id of the NFT you want to claim
   * const quantity = 1; // how many NFTs you want to claim
   *
   * const tx = await contract.erc1155.claim(tokenId, quantity);
   * const receipt = tx.receipt; // the transaction receipt
   * ```
   *
   * @param tokenId - Id of the token you want to claim
   * @param quantity - Quantity of the tokens you want to claim
   * @param options - Optional claim verification data (e.g. price, currency, etc...)
   *
   * @returns - Receipt for the transaction
   * @twfeature ERC1155Claimable
   */
  public async claim(
    tokenId: BigNumberish,
    quantity: BigNumberish,
    options?: ClaimOptions,
  ): Promise<TransactionResult> {
    return this.claimTo(
      await this.contractWrapper.getSignerAddress(),
      tokenId,
      quantity,
      options,
    );
  }

  /**
   * Claim NFTs to a specific Wallet
   *
   * @remarks Let the specified wallet claim NFTs.
   *
   * @example
   * ```javascript
   * const address = "{{wallet_address}}"; // address of the wallet you want to claim the NFTs
   * const tokenId = 0; // the id of the NFT you want to claim
   * const quantity = 1; // how many NFTs you want to claim
   *
   * const tx = await contract.erc1155.claimTo(address, tokenId, quantity);
   * const receipt = tx.receipt; // the transaction receipt
   * ```
   *
   * @param destinationAddress - Address you want to send the token to
   * @param tokenId - Id of the token you want to claim
   * @param quantity - Quantity of the tokens you want to claim
   * @param options - Optional claim verification data (e.g. price, currency, etc...)
   *
   * @returns - Receipt for the transaction
   * @twfeature ERC1155Claimable
   */
  public async claimTo(
    destinationAddress: string,
    tokenId: BigNumberish,
    quantity: BigNumberish,
    options?: ClaimOptions,
  ): Promise<TransactionResult> {
    const claimWithConditions = this.lazyMintable?.claimWithConditions;
    const claim = this.lazyMintable?.claim;
    if (claimWithConditions) {
      return claimWithConditions.to(
        destinationAddress,
        tokenId,
        quantity,
        options,
      );
    }
    if (claim) {
      return claim.to(destinationAddress, tokenId, quantity, options);
    }
    throw new ExtensionNotImplementedError(FEATURE_EDITION_CLAIMABLE);
  }

  /**
   * Configure claim conditions
   * @remarks Define who can claim NFTs in the collection, when and how many.
   * @example
   * ```javascript
   * const presaleStartTime = new Date();
   * const publicSaleStartTime = new Date(Date.now() + 60 * 60 * 24 * 1000);
   * const claimConditions = [
   *   {
   *     startTime: presaleStartTime, // start the presale now
   *     maxQuantity: 2, // limit how many mints for this presale
   *     price: 0.01, // presale price
   *     snapshot: ['0x...', '0x...'], // limit minting to only certain addresses
   *   },
   *   {
   *     startTime: publicSaleStartTime, // 24h after presale, start public sale
   *     price: 0.08, // public sale price
   *   }
   * ]);
   * await contract.erc1155.claimConditions.set(tokenId, claimConditions);
   * ```
   * @twfeature ERC1155ClaimableWithConditions
   */
  get claimConditions() {
    return assertEnabled(
      this.lazyMintable?.claimWithConditions,
      FEATURE_EDITION_CLAIMABLE_WITH_CONDITIONS,
    ).conditions;
  }

  ////// ERC1155 SignatureMintable Extension //////

  /**
   * Signature Minting
   * @remarks Generate dynamic NFTs with your own signature, and let others mint them using that signature.
   * @example
   * ```javascript
   * // see how to craft a payload to sign in the `contract.erc1155.signature.generate()` documentation
   * const signedPayload = contract.erc1155.signature().generate(payload);
   *
   * // now anyone can mint the NFT
   * const tx = contract.erc1155.signature.mint(signedPayload);
   * const receipt = tx.receipt; // the mint transaction receipt
   * const mintedId = tx.id; // the id of the NFT minted
   * ```
   * @twfeature ERC1155SignatureMintable
   */
  get signature() {
    return assertEnabled(
      this.signatureMintable,
      FEATURE_EDITION_SIGNATURE_MINTABLE,
    );
  }

  ////// ERC1155 DelayedReveal Extension //////

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
   * await contract.erc1155.drop.revealer.createDelayedRevealBatch(
   *   placeholderNFT,
   *   realNFTs,
   *   "my secret password",
   * );
   * // Whenever you're ready, reveal your NFTs at any time
   * const batchId = 0; // the batch to reveal
   * await contract.erc1155.revealer.reveal(batchId, "my secret password");
   * ```
   * @twfeature ERC1155Revealable
   */
  get revealer() {
    return assertEnabled(
      this.lazyMintable?.revealer,
      FEATURE_EDITION_REVEALABLE,
    );
  }

  /** ******************************
   * PRIVATE FUNCTIONS
   *******************************/

  /**
   * @internal
   * @param tokenId - the token Id to fetch
   */
  public async getTokenMetadata(tokenId: BigNumberish): Promise<NFTMetadata> {
    const tokenUri = await this.contractWrapper.readContract.uri(tokenId);
    if (!tokenUri) {
      throw new NotFoundError();
    }
    return fetchTokenMetadata(tokenId, tokenUri, this.storage);
  }

  private detectErc1155Enumerable(): Erc1155Enumerable | undefined {
    if (
      detectContractFeature<BaseERC1155 & IERC1155Enumerable>(
        this.contractWrapper,
        "ERC1155Enumerable",
      )
    ) {
      return new Erc1155Enumerable(this, this.contractWrapper);
    }
    return undefined;
  }

  private detectErc1155Mintable(): Erc1155Mintable | undefined {
    if (
      detectContractFeature<IMintableERC1155>(
        this.contractWrapper,
        "ERC1155Mintable",
      )
    ) {
      return new Erc1155Mintable(this, this.contractWrapper, this.storage);
    }
    return undefined;
  }

  private detectErc1155Burnable(): Erc1155Burnable | undefined {
    if (
      detectContractFeature<IBurnableERC1155>(
        this.contractWrapper,
        "ERC1155Burnable",
      )
    ) {
      return new Erc1155Burnable(this.contractWrapper);
    }
    return undefined;
  }

  private detectErc1155LazyMintable(): Erc1155LazyMintable | undefined {
    if (
      detectContractFeature<BaseDropERC1155>(
        this.contractWrapper,
        "ERC1155LazyMintable",
      )
    ) {
      return new Erc1155LazyMintable(this, this.contractWrapper, this.storage);
    }
    return undefined;
  }

  private detectErc1155SignatureMintable():
    | Erc1155SignatureMintable
    | undefined {
    if (
      detectContractFeature<BaseSignatureMintERC1155>(
        this.contractWrapper,
        "ERC1155SignatureMintable",
      )
    ) {
      return new Erc1155SignatureMintable(this.contractWrapper, this.storage);
    }
    return undefined;
  }
}
