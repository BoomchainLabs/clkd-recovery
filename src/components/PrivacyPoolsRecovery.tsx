'use client';

import { useState, useCallback } from 'react';
import { createPublicClient, http, formatEther, encodeFunctionData, type Hex } from 'viem';
import { sepolia, mainnet } from 'viem/chains';
import {
  deriveMnemonic,
  deriveMasterKeys,
  deriveDepositSecrets,
  computePrecommitment,
  buildCommitment,
  getChainConfig,
  scanPoolEvents,
  getDepositStatus,
  getAspLeaves,
  getAspRoots,
  createSdk,
  generateCommitmentProof,
  generateWithdrawalProof,
  POOL_ABI,
  type ReviewStatus,
  type DepositRecord,
} from '@cloakedxyz/clkd-privacy-pools';

interface PoolDeposit {
  index: number;
  precommitment: bigint;
  deposit: DepositRecord;
  reviewStatus: ReviewStatus | 'unknown' | 'scanning';
  withdrawn: boolean;
}

interface Props {
  signature: Hex;
  chainId: 1 | 11155111;
}

const CHAIN_MAP = { 1: mainnet, 11155111: sepolia } as const;
const MAX_INDEX_SCAN = 50;

export function PrivacyPoolsRecovery({ signature, chainId }: Props) {
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [deposits, setDeposits] = useState<PoolDeposit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<number | null>(null);
  const [actionStatus, setActionStatus] = useState<string>('');
  const [txHash, setTxHash] = useState<string | null>(null);

  const scanForDeposits = useCallback(async () => {
    setScanning(true);
    setError(null);
    setDeposits([]);

    try {
      const config = getChainConfig(chainId);
      const chain = CHAIN_MAP[chainId];
      const client = createPublicClient({ chain, transport: http() });
      const poolConfig = config.pools['ETH'];
      if (!poolConfig) throw new Error('No ETH pool configured');

      // Derive mnemonic from wallet signature
      const mnemonic = await deriveMnemonic(signature);
      const masterKeys = deriveMasterKeys(mnemonic);

      // Read pool scope
      const scopeRes = await client.readContract({
        address: poolConfig.address as `0x${string}`,
        abi: POOL_ABI,
        functionName: 'SCOPE',
      });
      const scope = scopeRes as bigint;

      // Scan chain for all pool events
      const currentBlock = await client.getBlockNumber();
      const { depositsByPrecommitment } = await scanPoolEvents(
        client as any,
        poolConfig.address as `0x${string}`,
        config.startBlock,
        currentBlock
      );

      // Iterate through indices to find user's deposits
      const found: PoolDeposit[] = [];
      let consecutiveMisses = 0;

      for (let i = 0; i < MAX_INDEX_SCAN; i++) {
        const idx = BigInt(i);
        const secrets = deriveDepositSecrets(masterKeys, scope, idx);
        const precommitment = computePrecommitment(
          secrets.nullifier as any,
          secrets.secret as any
        );
        const deposit = depositsByPrecommitment.get(precommitment);

        if (deposit) {
          found.push({
            index: i,
            precommitment,
            deposit,
            reviewStatus: 'scanning',
            withdrawn: false,
          });
          consecutiveMisses = 0;
        } else {
          consecutiveMisses++;
          if (consecutiveMisses >= 10 && found.length > 0) break;
        }
      }

      // Check ASP status for each deposit
      for (const d of found) {
        try {
          const status = await getDepositStatus(
            config.aspApiBase,
            chainId,
            d.precommitment
          );
          d.reviewStatus = status?.reviewStatus ?? 'unknown';
        } catch {
          d.reviewStatus = 'unknown';
        }
      }

      setDeposits(found);
      setScanned(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }, [signature, chainId]);

  const handleWithdraw = useCallback(
    async (poolDeposit: PoolDeposit) => {
      setActionInProgress(poolDeposit.index);
      setActionStatus('Generating withdrawal proof...');
      setTxHash(null);
      setError(null);

      try {
        const config = getChainConfig(chainId);
        const poolConfig = config.pools['ETH']!;

        const mnemonic = await deriveMnemonic(signature);
        const masterKeys = deriveMasterKeys(mnemonic);

        const client = createPublicClient({
          chain: CHAIN_MAP[chainId],
          transport: http(),
        });

        const scopeRes = await client.readContract({
          address: poolConfig.address as `0x${string}`,
          abi: POOL_ABI,
          functionName: 'SCOPE',
        });
        const scope = scopeRes as bigint;

        const secrets = deriveDepositSecrets(masterKeys, scope, BigInt(poolDeposit.index));

        // Get state tree leaves
        setActionStatus('Indexing state tree...');
        const currentBlock = await client.getBlockNumber();
        const { leaves: stateLeaves } = await scanPoolEvents(
          client as any,
          poolConfig.address as `0x${string}`,
          config.startBlock,
          currentBlock
        );

        // Get ASP leaves
        setActionStatus('Fetching ASP data...');
        const aspLeavesData = await getAspLeaves(config.aspApiBase, chainId, scope);

        setActionStatus('Generating ZK proof (this may take a moment)...');

        const sdk = createSdk(
          'https://unpkg.com/@0xbow/privacy-pools-core-sdk@1.0.2/dist/node/',
          true
        );

        // We need the user to sign a transaction, but in recovery mode
        // we can only show them the calldata. Generate proof and show instructions.
        const { proof } = await generateWithdrawalProof(sdk, {
          masterKeys,
          value: poolDeposit.deposit.value,
          label: poolDeposit.deposit.label,
          nullifier: secrets.nullifier as any,
          secret: secrets.secret as any,
          scope,
          stateLeaves,
          aspLeaves: aspLeavesData.aspLeaves,
          recipient: '0x0000000000000000000000000000000000000000', // placeholder — user needs to provide
        });

        setActionStatus(
          'Proof generated! In recovery mode, you will need to submit this transaction manually. ' +
            'Copy the proof data and use it with a wallet or cast to call withdraw() on the pool contract.'
        );

        // For now, show the proof was generated successfully
        // Full withdrawal requires the user to sign a tx which needs wallet integration
        console.log('Withdrawal proof generated:', proof);
      } catch (err) {
        setError(
          `Withdrawal failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setActionInProgress(null);
      }
    },
    [signature, chainId]
  );

  const handleRagequit = useCallback(
    async (poolDeposit: PoolDeposit) => {
      setActionInProgress(poolDeposit.index);
      setActionStatus('Generating ragequit proof...');
      setTxHash(null);
      setError(null);

      try {
        const config = getChainConfig(chainId);
        const poolConfig = config.pools['ETH']!;

        const mnemonic = await deriveMnemonic(signature);
        const masterKeys = deriveMasterKeys(mnemonic);

        const client = createPublicClient({
          chain: CHAIN_MAP[chainId],
          transport: http(),
        });

        const scopeRes = await client.readContract({
          address: poolConfig.address as `0x${string}`,
          abi: POOL_ABI,
          functionName: 'SCOPE',
        });
        const scope = scopeRes as bigint;

        const secrets = deriveDepositSecrets(masterKeys, scope, BigInt(poolDeposit.index));

        setActionStatus('Generating commitment proof...');

        const sdk = createSdk(
          'https://unpkg.com/@0xbow/privacy-pools-core-sdk@1.0.2/dist/node/',
          true
        );

        const { proof } = await generateCommitmentProof(
          sdk,
          poolDeposit.deposit.value,
          poolDeposit.deposit.label,
          secrets.nullifier as any,
          secrets.secret as any
        );

        // Build the ragequit calldata
        const ragequitData = encodeFunctionData({
          abi: POOL_ABI,
          functionName: 'ragequit',
          args: [proof as any],
        });

        setActionStatus('Proof generated! Copy the calldata below to submit via your wallet.');

        // Store the calldata for the user to copy
        setTxHash(ragequitData);
        console.log('Ragequit calldata:', ragequitData);
        console.log('Send to pool contract:', poolConfig.address);
      } catch (err) {
        setError(
          `Ragequit failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setActionInProgress(null);
      }
    },
    [signature, chainId]
  );

  const statusLabel = (status: ReviewStatus | 'unknown' | 'scanning') => {
    switch (status) {
      case 'approved':
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            Approved
          </span>
        );
      case 'declined':
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            Declined
          </span>
        );
      case 'pending':
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-700 bg-yellow-50 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
            Pending
          </span>
        );
      case 'scanning':
        return (
          <span className="text-xs text-text-muted">Checking...</span>
        );
      default:
        return (
          <span className="text-xs text-text-muted">Unknown</span>
        );
    }
  };

  return (
    <div className="mt-8 border-t border-gray-200 pt-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#7B4DFF"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Privacy Pools
            </h3>
            <p className="text-xs text-text-muted">
              Scan for deposits in 0xbow Privacy Pools
            </p>
          </div>
        </div>

        {!scanned && (
          <button
            onClick={scanForDeposits}
            disabled={scanning}
            className="text-sm bg-primary hover:bg-primary-light text-white font-medium px-4 py-2 rounded-lg shadow-button transition-all disabled:opacity-50 flex items-center gap-2"
          >
            {scanning && (
              <svg
                className="animate-spin h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {scanning ? 'Scanning...' : 'Scan for Deposits'}
          </button>
        )}

        {scanned && (
          <button
            onClick={scanForDeposits}
            disabled={scanning}
            className="text-sm text-primary hover:text-primary-light font-medium px-3 py-1.5 rounded-md border border-primary/30 hover:border-primary transition-colors disabled:opacity-50"
          >
            Rescan
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
          <p className="text-red-600 text-sm">{error}</p>
        </div>
      )}

      {scanned && deposits.length === 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
          <p className="text-text-muted text-sm">
            No Privacy Pool deposits found for this wallet on{' '}
            {chainId === 1 ? 'Ethereum' : 'Sepolia'}.
          </p>
        </div>
      )}

      {deposits.length > 0 && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-card-raised border-b border-gray-200">
                <th className="text-left px-4 py-3 text-text-muted font-medium w-16">
                  #
                </th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">
                  Value
                </th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">
                  Status
                </th>
                <th className="text-right px-4 py-3 text-text-muted font-medium">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {deposits.map((d) => (
                <tr
                  key={d.index}
                  className="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                >
                  <td className="px-4 py-3 text-text-muted font-mono">
                    {d.index}
                  </td>
                  <td className="px-4 py-3 font-mono text-text-primary">
                    {formatEther(d.deposit.value)} ETH
                  </td>
                  <td className="px-4 py-3">{statusLabel(d.reviewStatus)}</td>
                  <td className="px-4 py-3 text-right">
                    {d.reviewStatus === 'approved' && (
                      <button
                        onClick={() => handleWithdraw(d)}
                        disabled={actionInProgress !== null}
                        className="text-xs bg-primary hover:bg-primary-light text-white font-medium px-3 py-1.5 rounded-md transition-all disabled:opacity-50"
                      >
                        {actionInProgress === d.index
                          ? 'Working...'
                          : 'Withdraw'}
                      </button>
                    )}
                    {d.reviewStatus === 'declined' && (
                      <button
                        onClick={() => handleRagequit(d)}
                        disabled={actionInProgress !== null}
                        className="text-xs bg-red-500 hover:bg-red-600 text-white font-medium px-3 py-1.5 rounded-md transition-all disabled:opacity-50"
                      >
                        {actionInProgress === d.index
                          ? 'Working...'
                          : 'Ragequit'}
                      </button>
                    )}
                    {d.reviewStatus === 'pending' && (
                      <span className="text-xs text-text-muted">
                        Awaiting review
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {actionStatus && (
        <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
          <p className="text-blue-700 text-sm">{actionStatus}</p>
        </div>
      )}

      {txHash && (
        <div className="mt-3">
          <p className="text-xs text-text-muted mb-1">
            Transaction calldata (send to pool contract):
          </p>
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 max-h-24 overflow-y-auto">
            <code className="text-xs text-text-primary break-all font-mono">
              {txHash}
            </code>
          </div>
          <button
            onClick={() => {
              navigator.clipboard.writeText(txHash);
            }}
            className="mt-2 text-xs text-primary hover:text-primary-light font-medium"
          >
            Copy calldata
          </button>
        </div>
      )}

      {scanned && deposits.length > 0 && (
        <p className="mt-4 text-xs text-text-muted">
          Pool contract:{' '}
          <span className="font-mono">
            {getChainConfig(chainId).pools['ETH']?.address}
          </span>
        </p>
      )}
    </div>
  );
}
