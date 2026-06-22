const express = require('express');
const session = require('express-session');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const ed25519 = require('ed25519-hd-key');
const { 
    Keypair, 
    Connection, 
    clusterApiUrl, 
    PublicKey, 
    SystemProgram, 
    Transaction, 
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware Setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'tactical-override-key-999',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 } // 1 hour session
}));

// --- Blockchain RPC Providers ---
// Using public RPCs for demonstration. In production, replace with Alchemy/Infura/QuickNode keys.
const ethProvider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
const solConnection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// Global In-Memory State for Active Escrow Bets
const activeBets = new Map();

// --- Cryptography & Blockchain Helpers ---

function deriveWalletsFromMnemonic(mnemonic) {
    // 1. Derive EVM Wallet
    const ethWallet = ethers.Wallet.fromPhrase(mnemonic);

    // 2. Derive Solana Wallet (m/44'/501'/0'/0')
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const solanaDerivationPath = "m/44'/501'/0'/0'";
    const derivedSeed = ed25519.derivePath(solanaDerivationPath, seed.toString('hex')).key;
    const solanaKeypair = Keypair.fromSeed(derivedSeed);

    return {
        mnemonic,
        ethAddress: ethWallet.address,
        ethPrivateKey: ethWallet.privateKey, // Required for real transactions
        solAddress: solanaKeypair.publicKey.toBase58(),
        solSecretKey: Buffer.from(solanaKeypair.secretKey).toString('hex') // Required for real transactions
    };
}

// Fetches REAL live balances from the blockchains
async function fetchLiveBalances(ethAddress, solAddress) {
    try {
        // Fetch ETH
        const ethBalanceWei = await ethProvider.getBalance(ethAddress);
        const ethBalance = parseFloat(ethers.formatEther(ethBalanceWei));

        // Fetch SOL
        const solPubKey = new PublicKey(solAddress);
        const solBalanceLamports = await solConnection.getBalance(solPubKey);
        const solBalance = solBalanceLamports / LAMPORTS_PER_SOL;

        // Static approximate USD rates for UI purposes
        const ethRate = 3200;
        const solRate = 140;

        return {
            eth: ethBalance,
            sol: solBalance,
            usd: (ethBalance * ethRate) + (solBalance * solRate)
        };
    } catch (error) {
        console.error("[RPC ERROR] Failed to fetch live balances:", error.message);
        return { eth: 0, sol: 0, usd: 0 };
    }
}

function generateEscrowWallet(chain) {
    if (chain === 'SOL') {
        const keypair = Keypair.generate();
        return {
            address: keypair.publicKey.toBase58(),
            privateKey: Buffer.from(keypair.secretKey).toString('hex')
        };
    } else {
        const wallet = ethers.Wallet.createRandom();
        return {
            address: wallet.address,
            privateKey: wallet.privateKey
        };
    }
}

// --- Core Routes ---

app.get('/', (req, res) => {
    if (req.session.wallet) return res.redirect('/wallet/portfolio');
    res.render('index', { error: null });
});

app.post('/generate', async (req, res) => {
    try {
        const mnemonic = bip39.generateMnemonic();
        const walletData = deriveWalletsFromMnemonic(mnemonic);
        
        // Fetch real balances (will be 0 for a new wallet, but verifies connection)
        walletData.balances = await fetchLiveBalances(walletData.ethAddress, walletData.solAddress);
        req.session.wallet = walletData;
        
        res.redirect('/wallet/portfolio');
    } catch (error) {
        console.error(error);
        res.render('index', { error: 'Failed to generate cryptographic seed.' });
    }
});

app.post('/import', async (req, res) => {
    try {
        const mnemonic = req.body.mnemonic.trim();
        if (!bip39.validateMnemonic(mnemonic)) throw new Error("Invalid mnemonic phrase.");
        
        const walletData = deriveWalletsFromMnemonic(mnemonic);
        
        // Fetch real balances from mainnet
        walletData.balances = await fetchLiveBalances(walletData.ethAddress, walletData.solAddress);
        req.session.wallet = walletData;
        
        res.redirect('/wallet/portfolio');
    } catch (error) {
        res.render('index', { error: 'INVALID SEED PHRASE. VERIFY INTEGRITY AND RETRY.' });
    }
});

// Unified route to render views with active tab states
app.get('/wallet/:tab', async (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    const validTabs = ['portfolio', 'receive', 'send', 'trade'];
    const activeTab = validTabs.includes(req.params.tab) ? req.params.tab : 'portfolio';
    
    // Refresh balances strictly on portfolio load
    if (activeTab === 'portfolio') {
        req.session.wallet.balances = await fetchLiveBalances(req.session.wallet.ethAddress, req.session.wallet.solAddress);
    }

    const publicBets = Array.from(activeBets.values()).filter(bet => !bet.isPrivate && bet.status === 'pending');
    
    // Serve trade.ejs for the Arena
    if (activeTab === 'trade') {
        return res.render('trade', { 
            wallet: req.session.wallet, 
            publicBets: publicBets,
            error: req.query.error || null,
            success: req.query.success || null
        });
    }

    // Serve standard wallet.ejs
    res.render('wallet', { 
        wallet: req.session.wallet, 
        activeTab: activeTab,
        publicBets: publicBets,
        error: req.query.error || null,
        success: req.query.success || null
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// --- Real On-Chain Transmit Logic ---

app.post('/transmit', async (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    const { network, targetAddress, amount } = req.body;
    const userWallet = req.session.wallet;

    try {
        if (network === 'ETH') {
            const wallet = new ethers.Wallet(userWallet.ethPrivateKey, ethProvider);
            const tx = await wallet.sendTransaction({
                to: targetAddress,
                value: ethers.parseEther(amount.toString())
            });
            await tx.wait(); // Wait for confirmation
            res.redirect(`/wallet/send?success=ETH Transmitted. TX Hash: ${tx.hash}`);
        } else if (network === 'SOL') {
            const fromKeypair = Keypair.fromSecretKey(Buffer.from(userWallet.solSecretKey, 'hex'));
            const toPublicKey = new PublicKey(targetAddress);
            
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: fromKeypair.publicKey,
                    toPubkey: toPublicKey,
                    lamports: parseFloat(amount) * LAMPORTS_PER_SOL,
                })
            );
            
            const signature = await sendAndConfirmTransaction(solConnection, transaction, [fromKeypair]);
            res.redirect(`/wallet/send?success=SOL Transmitted. Signature: ${signature}`);
        }
    } catch (error) {
        console.error("[TRANSMIT ERROR]", error);
        res.redirect(`/wallet/send?error=Transaction Failed: ${error.message}`);
    }
});

// --- Betting / Escrow API Actions ---

// 1. Host a new bet (Requires Real Funds)
app.post('/trade/host', async (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    const { game, chain, amountUSD, isPrivate } = req.body;
    const betAmount = parseFloat(amountUSD);
    const userWallet = req.session.wallet;

    // Refresh balance to ensure they haven't spent it elsewhere
    userWallet.balances = await fetchLiveBalances(userWallet.ethAddress, userWallet.solAddress);
    
    const selectedBalance = chain === 'SOL' ? userWallet.balances.sol : userWallet.balances.eth;
    const rate = chain === 'SOL' ? 140 : 3200; 
    const costInCrypto = betAmount / rate;

    if (selectedBalance < costInCrypto) {
        return res.redirect('/wallet/trade?error=Insufficient on-chain funds to lock escrow.');
    }

    try {
        // Generate actual transient escrow wallet
        const escrow = generateEscrowWallet(chain);
        const betId = crypto.randomBytes(4).toString('hex');
        const accessKey = isPrivate ? crypto.randomBytes(3).toString('hex').toUpperCase() : null;

        /* 
        =======================================================================
        REAL ON-CHAIN TRANSFER TO ESCROW (WARNING: REQUIRES GAS)
        Uncomment the execution block below to force real fund transfers. 
        If users have 0 balances, this will throw a gas error.
        =======================================================================
        */
        
        /*
        if (chain === 'ETH') {
            const wallet = new ethers.Wallet(userWallet.ethPrivateKey, ethProvider);
            const tx = await wallet.sendTransaction({ to: escrow.address, value: ethers.parseEther(costInCrypto.toString()) });
            await tx.wait();
        } else if (chain === 'SOL') {
            const fromKeypair = Keypair.fromSecretKey(Buffer.from(userWallet.solSecretKey, 'hex'));
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: fromKeypair.publicKey,
                    toPubkey: new PublicKey(escrow.address),
                    lamports: costInCrypto * LAMPORTS_PER_SOL,
                })
            );
            await sendAndConfirmTransaction(solConnection, transaction, [fromKeypair]);
        }
        */

        const newBet = {
            id: betId,
            hostAddress: chain === 'SOL' ? userWallet.solAddress : userWallet.ethAddress,
            hostChain: chain,
            amountUSD: betAmount,
            cryptoAmount: costInCrypto.toFixed(4),
            game: game,
            status: 'pending',
            isPrivate: !!isPrivate,
            accessKey: accessKey,
            escrowAddress: escrow.address,
            escrowPrivateKey: escrow.privateKey,
            playerAddress: null
        };

        activeBets.set(betId, newBet);
        res.redirect(`/wallet/trade?success=Bet hosted securely. ID: ${betId} ${accessKey ? `[Key: ${accessKey}]` : ''}`);

    } catch (error) {
        console.error("[ESCROW LOCK ERROR]", error);
        res.redirect(`/wallet/trade?error=Failed to lock funds on-chain: ${error.message}`);
    }
});

// 2. Join and Resolve
app.post('/trade/join', async (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    const { betId, accessKey } = req.body;
    const bet = activeBets.get(betId) || Array.from(activeBets.values()).find(b => b.accessKey === accessKey?.toUpperCase());

    if (!bet) return res.redirect('/wallet/trade?error=Target match session could not be located.');
    if (bet.status !== 'pending') return res.redirect('/wallet/trade?error=Match session is no longer open.');

    const userWallet = req.session.wallet;
    const targetAddress = bet.hostChain === 'SOL' ? userWallet.solAddress : userWallet.ethAddress;

    if (bet.hostAddress === targetAddress) {
        return res.redirect('/wallet/trade?error=You cannot challenge your own session.');
    }

    userWallet.balances = await fetchLiveBalances(userWallet.ethAddress, userWallet.solAddress);
    const playerBalance = bet.hostChain === 'SOL' ? userWallet.balances.sol : userWallet.balances.eth;
    
    if (playerBalance < parseFloat(bet.cryptoAmount)) {
        return res.redirect('/wallet/trade?error=Inadequate on-chain token balance to match challenge stake.');
    }

    try {
        bet.playerAddress = targetAddress;
        bet.status = 'active';

        // Deterministic Game Engine Execution
        const outcomes = ['host', 'player'];
        const winnerDecision = outcomes[Math.floor(Math.random() * outcomes.length)];
        const absoluteWinnerAddress = winnerDecision === 'host' ? bet.hostAddress : bet.playerAddress;

        // In a fully activated real-money script, the server would now sign a transaction 
        // from the `bet.escrowPrivateKey` to send the combined pool to `absoluteWinnerAddress`.

        bet.status = 'completed';
        bet.winner = absoluteWinnerAddress;
        setTimeout(() => activeBets.delete(bet.id), 60000);

        const matchResultMessage = winnerDecision === 'host' ? 'Host won the match matrix.' : 'Challenger claimed victory.';
        res.redirect(`/wallet/trade?success=Game resolved! Result: ${matchResultMessage}`);
    } catch (error) {
        console.error("[ESCROW RESOLVE ERROR]", error);
        res.redirect(`/wallet/trade?error=Blockchain execution failed during match resolution.`);
    }
});

app.listen(PORT, () => console.log(`[SYSTEM] Core RPC Engine operational on port ${PORT}`));
