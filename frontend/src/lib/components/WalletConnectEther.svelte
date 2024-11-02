<script>
	// @ts-nocheck

	import { ethers } from "ethers";
	import { CoinbaseWalletSDK } from "@coinbase/wallet-sdk";
	import { signerAddress } from "ethers-svelte";

	const sdk = new CoinbaseWalletSDK({
		appName: "Conversation Station",
		appChainIds: [1],
	});

	export let web3Props;
	console.log($signerAddress);
	async function connectWallet() {
		if (window !== undefined && typeof window.ethereum != "undefined") {
			// Create provider
			const provider = sdk.makeWeb3Provider({
				options: "smartWalletOnly",
			});
			// Use provider
			const addresses = provider.request({
				method: "eth_requestAccounts",
			});

			const address = await addresses;

			web3Props = {
				signer: provider.signer,
				provider,
				address: address[0],
			};
		}
	}
</script>

{#if !$signerAddress && !web3Props?.signer}
	<button class="btn" on:click={connectWallet}>Connect Wallet</button>
{:else}
	<div>
		Connected to: {web3Props?.address.substr(0, 6) ||
			$signerAddress?.substr(0, 6)}..
	</div>
{/if}
