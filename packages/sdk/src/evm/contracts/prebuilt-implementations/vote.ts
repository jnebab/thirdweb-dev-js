import {
  fetchCurrencyMetadata,
  fetchCurrencyValue,
} from "../../common/currency";
import { ContractEncoder } from "../../core/classes/contract-encoder";
import { ContractEvents } from "../../core/classes/contract-events";
import { ContractInterceptor } from "../../core/classes/contract-interceptor";
import { ContractMetadata } from "../../core/classes/contract-metadata";
import { ContractWrapper } from "../../core/classes/contract-wrapper";
import { GasCostEstimator } from "../../core/classes/gas-cost-estimator";
import { UpdateableNetwork } from "../../core/interfaces/contract";
import {
  NetworkOrSignerOrProvider,
  TransactionResult,
  TransactionResultWithId,
} from "../../core/types";
import { VoteType } from "../../enums";
import { VoteContractSchema } from "../../schema/contracts/vote";
import { SDKOptions } from "../../schema/sdk-options";
import { CurrencyValue } from "../../types/currency";
import {
  Proposal,
  ProposalExecutable,
  ProposalVote,
  VoteSettings,
} from "../../types/vote";
import type { IERC20, VoteERC20 } from "@thirdweb-dev/contracts-js";
import ERC20Abi from "@thirdweb-dev/contracts-js/dist/abis/IERC20.json";
import type ABI from "@thirdweb-dev/contracts-js/dist/abis/VoteERC20.json";
import { ProposalCreatedEvent } from "@thirdweb-dev/contracts-js/dist/declarations/src/VoteERC20";
import { ThirdwebStorage } from "@thirdweb-dev/storage";
import {
  BigNumber,
  BigNumberish,
  CallOverrides,
  Contract,
  ethers,
} from "ethers";

/**
 * Create a decentralized organization for token holders to vote on proposals.
 *
 * @example
 *
 * ```javascript
 * import { ThirdwebSDK } from "@thirdweb-dev/sdk";
 *
 * const sdk = new ThirdwebSDK("{{chainName}}");
 * const contract = sdk.getVote("{{contract_address}}");
 * ```
 *
 * @public
 */
export class Vote implements UpdateableNetwork {
  private contractWrapper: ContractWrapper<VoteERC20>;
  private storage: ThirdwebStorage;

  public abi: typeof ABI;
  public metadata: ContractMetadata<VoteERC20, typeof VoteContractSchema>;
  public encoder: ContractEncoder<VoteERC20>;
  public estimator: GasCostEstimator<VoteERC20>;
  public events: ContractEvents<VoteERC20>;
  /**
   * @internal
   */
  public interceptor: ContractInterceptor<VoteERC20>;

  constructor(
    network: NetworkOrSignerOrProvider,
    address: string,
    storage: ThirdwebStorage,
    options: SDKOptions = {},
    abi: typeof ABI,
    contractWrapper = new ContractWrapper<VoteERC20>(
      network,
      address,
      abi,
      options,
    ),
  ) {
    this.abi = abi;
    this.contractWrapper = contractWrapper;
    this.storage = storage;
    this.metadata = new ContractMetadata(
      this.contractWrapper,
      VoteContractSchema,
      this.storage,
    );
    this.encoder = new ContractEncoder(this.contractWrapper);
    this.estimator = new GasCostEstimator(this.contractWrapper);
    this.events = new ContractEvents(this.contractWrapper);
    this.interceptor = new ContractInterceptor(this.contractWrapper);
  }

  onNetworkUpdated(network: NetworkOrSignerOrProvider) {
    this.contractWrapper.updateSignerOrProvider(network);
  }

  getAddress(): string {
    return this.contractWrapper.readContract.address;
  }

  /** ******************************
   * READ FUNCTIONS
   *******************************/

  /**
   * Get a proposal by id.
   *
   * @param proposalId - The proposal id to get.
   * @returns - The proposal.
   */
  public async get(proposalId: BigNumberish): Promise<Proposal> {
    const all = await this.getAll();
    const proposals = all.filter((p) =>
      p.proposalId.eq(BigNumber.from(proposalId)),
    );
    if (proposals.length === 0) {
      throw new Error("proposal not found");
    }
    return proposals[0];
  }

  /**
   * Get All Proposals
   *
   * @remarks Get all the proposals in this contract.
   *
   * @example
   * ```javascript
   * const proposals = await contract.getAll();
   * console.log(proposals);
   * ```
   *
   * @returns - All the proposals in the contract.
   */
  public async getAll(): Promise<Proposal[]> {
    return Promise.all(
      (await this.contractWrapper.readContract.getAllProposals()).map(
        async (data) => ({
          proposalId: data.proposalId,
          proposer: data.proposer,
          description: data.description,
          startBlock: data.startBlock,
          endBlock: data.endBlock,
          state: await this.contractWrapper.readContract.state(data.proposalId),
          votes: await this.getProposalVotes(data.proposalId),
          executions: data[3].map((c, i) => ({
            toAddress: data.targets[i],
            nativeTokenValue: c,
            transactionData: data.calldatas[i],
          })),
        }),
      ),
    );
  }

  /**
   * Get the votes for a specific proposal
   * @param proposalId - the proposalId
   */
  public async getProposalVotes(
    proposalId: BigNumber,
  ): Promise<ProposalVote[]> {
    const votes = await this.contractWrapper.readContract.proposalVotes(
      proposalId,
    );
    return [
      {
        type: VoteType.Against,
        label: "Against",
        count: votes.againstVotes,
      },
      {
        type: VoteType.For,
        label: "For",
        count: votes.forVotes,
      },
      {
        type: VoteType.Abstain,
        label: "Abstain",
        count: votes.abstainVotes,
      },
    ];
  }

  /**
   * Check If Wallet Voted
   *
   * @remarks Check if a specified wallet has voted a specific proposal
   *
   * @example
   * ```javascript
   * // The proposal ID of the proposal you want to check
   * const proposalId = "0";
   * // The address of the wallet you want to check to see if they voted
   * const address = "{{wallet_address}}";
   *
   * await contract.hasVoted(proposalId, address);
   * ```
   *
   * @param proposalId - The unique identifier of a proposal .
   * @param account - (optional) wallet account address. Defaults to connected signer.
   * @returns - True if the account has already voted on the proposal.
   */
  public async hasVoted(
    proposalId: string,
    account?: string,
  ): Promise<boolean> {
    if (!account) {
      account = await this.contractWrapper.getSignerAddress();
    }
    return this.contractWrapper.readContract.hasVoted(proposalId, account);
  }

  /**
   * Can Execute
   *
   * @remarks Check if a proposal can be executed (if the proposal has succeeded).
   *
   * @example
   * ```javascript
   * // The proposal ID of the proposal you want to check
   * const proposalId = "0";
   * const canExecute = await contract.canExecute(proposalId);
   * console.log(canExecute);
   * ```
   *
   * @param proposalId - The proposal ID to check.
   * @returns - True if the proposal can be executed, false otherwise.
   */
  public async canExecute(proposalId: string): Promise<boolean> {
    await this.ensureExists(proposalId);

    const proposal = await this.get(proposalId);
    const tos = proposal.executions.map((p) => p.toAddress);
    const values = proposal.executions.map((p) => p.nativeTokenValue);
    const datas = proposal.executions.map((p) => p.transactionData);
    const descriptionHash = ethers.utils.id(proposal.description);
    try {
      await this.contractWrapper
        .callStatic()
        .execute(tos, values, datas, descriptionHash);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Check the balance of the project wallet in the native token of the chain
   *
   * @returns - The balance of the project in the native token of the chain
   */
  public async balance(): Promise<CurrencyValue> {
    const balance = await this.contractWrapper.readContract.provider.getBalance(
      this.contractWrapper.readContract.address,
    );
    return {
      name: "",
      symbol: "",
      decimals: 18,
      value: balance,
      displayValue: ethers.utils.formatUnits(balance, 18),
    };
  }

  /**
   * Check the balance of the project wallet in a particular
   * ERC20 token contract
   *
   * @returns - The balance of the project in the native token of the chain
   */
  public async balanceOfToken(tokenAddress: string): Promise<CurrencyValue> {
    const erc20 = new Contract(
      tokenAddress,
      ERC20Abi,
      this.contractWrapper.getProvider(),
    ) as IERC20;
    return await fetchCurrencyValue(
      this.contractWrapper.getProvider(),
      tokenAddress,
      await erc20.balanceOf(this.contractWrapper.readContract.address),
    );
  }

  /**
   * Find a proposal by its id.
   *
   * @internal
   * @param proposalId - Proposal to check for
   */
  private async ensureExists(proposalId: string): Promise<void> {
    try {
      await this.contractWrapper.readContract.state(proposalId);
    } catch (e) {
      throw Error(`Proposal ${proposalId} not found`);
    }
  }

  /**
   * Get the Vote contract configuration
   */
  public async settings(): Promise<VoteSettings> {
    const [
      votingDelay,
      votingPeriod,
      votingTokenAddress,
      votingQuorumFraction,
      proposalTokenThreshold,
    ] = await Promise.all([
      this.contractWrapper.readContract.votingDelay(),
      this.contractWrapper.readContract.votingPeriod(),
      this.contractWrapper.readContract.token(),
      this.contractWrapper.readContract.quorumNumerator(),
      this.contractWrapper.readContract.proposalThreshold(),
    ]);
    const votingTokenMetadata = await fetchCurrencyMetadata(
      this.contractWrapper.getProvider(),
      votingTokenAddress,
    );
    return {
      votingDelay: votingDelay.toString(),
      votingPeriod: votingPeriod.toString(),
      votingTokenAddress,
      votingTokenMetadata,
      votingQuorumFraction: votingQuorumFraction.toString(),
      proposalTokenThreshold: proposalTokenThreshold.toString(),
    };
  }

  /** ******************************
   * WRITE FUNCTIONS
   *******************************/

  /**
   * Create Proposal
   *
   * @remarks Create a new proposal for token holders to vote on.
   *
   * @example
   * ```javascript
   * // The description of the proposal you want to pass
   * const description = "This is a great proposal - vote for it!"
   * // You can (optionally) pass in contract calls that will get executed when the proposal is executed.
   * const executions = [
   *   {
   *     // The contract you want to make a call to
   *     toAddress: "0x...",
   *     // The amount of the native currency to send in this transaction
   *     nativeTokenValue: 0,
   *     // Transaction data that will be executed when the proposal is executed
   *     // This is an example transfer transaction with a token contract (which you would need to setup in code)
   *     transactionData: tokenContract.encoder.encode(
   *       "transfer", [
   *         fromAddress,
   *         amount,
   *       ]
   *     ),
   *   }
   * ]
   *
   * const proposal = await contract.propose(description, executions);
   * ```
   *
   * @param description - The description of the proposal.
   * @param executions - A set of executable transactions that will be run if the proposal is passed and executed.
   * @returns - The id of the created proposal and the transaction receipt.
   */
  public async propose(
    description: string,
    executions?: ProposalExecutable[],
  ): Promise<TransactionResultWithId> {
    if (!executions) {
      executions = [
        {
          toAddress: this.contractWrapper.readContract.address,
          nativeTokenValue: 0,
          transactionData: "0x",
        },
      ];
    }
    const tos = executions.map((p) => p.toAddress);
    const values = executions.map((p) => p.nativeTokenValue);
    const datas = executions.map((p) => p.transactionData);
    const receipt = await this.contractWrapper.sendTransaction("propose", [
      tos,
      values,
      datas,
      description,
    ]);
    const event = this.contractWrapper.parseLogs<ProposalCreatedEvent>(
      "ProposalCreated",
      receipt?.logs,
    );
    return {
      id: event[0].args.proposalId,
      receipt,
    };
  }

  /**
   * Vote
   *
   * @remarks Vote on an active proposal
   *
   * @example
   * ```javascript
   * // The proposal ID of the proposal you want to vote on
   * const proposalId = "0";
   * // The vote type you want to cast, can be VoteType.Against, VoteType.For, or VoteType.Abstain
   * const voteType = VoteType.For;
   * // The (optional) reason for the vote
   * const reason = "I like this proposal!";
   *
   * await contract.vote(proposalId, voteType, reason);
   * ```
   * @param proposalId - The proposal to cast a vote on.
   * @param voteType - The position the voter is taking on their vote.
   * @param reason - (optional) The reason for the vote.
   */
  public async vote(
    proposalId: string,
    voteType: VoteType,
    reason = "",
  ): Promise<TransactionResult> {
    await this.ensureExists(proposalId);
    return {
      receipt: await this.contractWrapper.sendTransaction(
        "castVoteWithReason",
        [proposalId, voteType, reason],
      ),
    };
  }

  /**
   * Execute Proposal
   *
   * @remarks Execute the related transactions for a proposal if the proposal succeeded.
   *
   * @example
   * ```javascript
   * // The proposal ID ofthe proposal you want to execute
   * const proposalId = "0"
   * await contract.execute(proposalId);
   * ```
   *
   * @param proposalId - The proposal id to execute.
   */
  public async execute(proposalId: string): Promise<TransactionResult> {
    await this.ensureExists(proposalId);

    const proposal = await this.get(proposalId);
    const tos = proposal.executions.map((p) => p.toAddress);
    const values = proposal.executions.map((p) => p.nativeTokenValue);
    const datas = proposal.executions.map((p) => p.transactionData);
    const descriptionHash = ethers.utils.id(proposal.description);
    return {
      receipt: await this.contractWrapper.sendTransaction("execute", [
        tos,
        values,
        datas,
        descriptionHash,
      ]),
    };
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
