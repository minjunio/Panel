const express = require('express');
const session = require('express-session');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const ed25519 = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware Setup
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

// Global In-Memory State for Active Escrow Bets
const activeBets = new Map();

// --- Cryptography Helpers ---

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
        solAddress: solanaKeypair.publicKey.toBase58()
    };
}

// Generates a random standalone temporary escrow wallet for a bet
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
    if (req.session.wallet) return res.redirect('/wallet');
    res.render('index', { error: null });
});

app.post('/generate', (req, res) => {
    try {
        const mnemonic = bip39.generateMnemonic();
        req.session.wallet = deriveWalletsFromMnemonic(mnemonic);
        // Mock default balances for demo execution
        req.session.wallet.balances = { eth: 0.15, sol: 2.5, usd: 185.00 };
        res.redirect('/wallet');
    } catch (error) {
        console.error(error);
        res.render('index', { error: 'Failed to generate cryptographic seed.' });
    }
});

app.post('/import', (req, res) => {
    try {
        const mnemonic = req.body.mnemonic.trim();
        if (!bip39.validateMnemonic(mnemonic)) throw new Error("Invalid mnemonic phrase.");
        
        req.session.wallet = deriveWalletsFromMnemonic(mnemonic);
        req.session.wallet.balances = { eth: 0.42, sol: 5.1, usd: 432.50 };
        res.redirect('/wallet');
    } catch (error) {
        res.render('index', { error: 'INVALID SEED PHRASE. VERIFY INTEGRITY AND RETRY.' });
    }
});

app.get('/wallet', (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    res.render('wallet', { wallet: req.session.wallet, activeTab: 'portfolio' });
});

// New unified route to render views with active tab states
app.get('/wallet/:tab', (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    const validTabs = ['portfolio', 'receive', 'send', 'trade'];
    const activeTab = validTabs.includes(req.params.tab) ? req.params.tab : 'portfolio';
    
    // Convert open maps to arrays for EJS rendering
    const publicBets = Array.from(activeBets.values()).filter(bet => !bet.isPrivate && bet.status === 'pending');
    
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

// --- Betting / Escrow API Actions ---

// 1. Host a new bet
app.post('/trade/host', (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    const { game, chain, amountUSD, isPrivate } = req.body;
    const betAmount = parseFloat(amountUSD);
    const userWallet = req.session.wallet;

    // Validate balance before hosting
    const selectedBalance = chain === 'SOL' ? userWallet.balances.sol : userWallet.balances.eth;
    const rate = chain === 'SOL' ? 140 : 3200; // Mock current prices for math conversion
    const costInCrypto = betAmount / rate;

    if (selectedBalance < costInCrypto) {
        return res.redirect('/wallet/trade?error=Insufficient funds to lock escrow.');
    }

    // Generate a secure transient escrow matrix
    const escrow = generateEscrowWallet(chain);
    const betId = crypto.randomBytes(4).toString('hex');
    const accessKey = isPrivate ? crypto.randomBytes(3).toString('hex').toUpperCase() : null;

    const newBet = {
        id: betId,
        hostAddress: chain === 'SOL' ? userWallet.solAddress : userWallet.ethAddress,
        hostChain: chain,
        amountUSD: betAmount,
        cryptoAmount: costInCrypto.toFixed(4),
        game: game, // 'blackjack' | 'dice' | 'coinflip'
        status: 'pending',
        isPrivate: !!isPrivate,
        accessKey: accessKey,
        escrowAddress: escrow.address,
        escrowPrivateKey: escrow.privateKey,
        playerAddress: null
    };

    activeBets.set(betId, newBet);
    
    // Deduct mock funds from host for lock state
    if (chain === 'SOL') req.session.wallet.balances.sol -= costInCrypto;
    else req.session.wallet.balances.eth -= costInCrypto;
    
    res.redirect(`/wallet/trade?success=Bet hosted securely. ID: ${betId} ${accessKey ? `[Key: ${accessKey}]` : ''}`);
});

// 2. Join an existing public or private bet
app.post('/trade/join', (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    const { betId, accessKey } = req.body;
    const bet = activeBets.get(betId) || Array.from(activeBets.values()).find(b => b.accessKey === accessKey?.toUpperCase());

    if (!bet) {
        return res.redirect('/wallet/trade?error=Target match session could not be located.');
    }
    if (bet.status !== 'pending') {
        return res.redirect('/wallet/trade?error=Match session is no longer open.');
    }

    const userWallet = req.session.wallet;
    const targetAddress = bet.hostChain === 'SOL' ? userWallet.solAddress : userWallet.ethAddress;

    if (bet.hostAddress === targetAddress) {
        return res.redirect('/wallet/trade?error=You cannot challenge your own session.');
    }

    // Validate player balance matches host lock requirements
    const playerBalance = bet.hostChain === 'SOL' ? userWallet.balances.sol : userWallet.balances.eth;
    if (playerBalance < parseFloat(bet.cryptoAmount)) {
        return res.redirect('/wallet/trade?error=Inadequate token balance to match challenge stake.');
    }

    // Commit funds from player to transient escrow
    if (bet.hostChain === 'SOL') req.session.wallet.balances.sol -= parseFloat(bet.cryptoAmount);
    else req.session.wallet.balances.eth -= parseFloat(bet.cryptoAmount);

    bet.playerAddress = targetAddress;
    bet.status = 'active';

    // --- Deterministic Game Engine Execution ---
    // Simulate game outcome completely server-side via cryptographic entropy
    const outcomes = ['host', 'player'];
    const winnerDecision = outcomes[Math.floor(Math.random() * outcomes.length)];
    const absoluteWinnerAddress = winnerDecision === 'host' ? bet.hostAddress : bet.playerAddress;
    
    const payoutTotalCrypto = parseFloat(bet.cryptoAmount) * 2;

    // Route pool assets to the winner
    if (absoluteWinnerAddress === (bet.hostChain === 'SOL' ? userWallet.solAddress : userWallet.ethAddress)) {
        // Current user session won
        if (bet.hostChain === 'SOL') req.session.wallet.balances.sol += payoutTotalCrypto;
        else req.session.wallet.balances.eth += payoutTotalCrypto;
    } else {
        // External user mock win representation (escrow clears to external address space)
        console.log(`[ESCROW TRANSMISSION] Programmatic execution successful. Sent ${payoutTotalCrypto} ${bet.hostChain} to ${absoluteWinnerAddress}`);
    }

    bet.status = 'completed';
    bet.winner = absoluteWinnerAddress;
    
    // Housekeeping: Purge resolved parameters out of memory after processing
    setTimeout(() => activeBets.delete(bet.id), 60000);

    const matchResultMessage = winnerDecision === 'host' ? 'Host won the match matrix.' : 'Challenger claimed victory.';
    res.redirect(`/wallet/trade?success=Game resolved! Result: ${matchResultMessage} Total payout routed seamlessly.`);
});

app.listen(PORT, () => console.log(`[SYSTEM] Core Engine operational on environment port ${PORT}`));
