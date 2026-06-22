const express = require('express');
const session = require('express-session');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const ed25519 = require('ed25519-hd-key');
const { Keypair, Connection, clusterApiUrl } = require('@solana/web3.js');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'tactical-override-key-999',
    resave: false,
    saveUninitialized: true
}));

// Global State for active bets/games
const activeGames = {};

function deriveWalletsFromMnemonic(mnemonic) {
    const ethWallet = ethers.Wallet.fromPhrase(mnemonic);
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const solanaDerivationPath = "m/44'/501'/0'/0'";
    const derivedSeed = ed25519.derivePath(solanaDerivationPath, seed.toString('hex')).key;
    const solanaKeypair = Keypair.fromSeed(derivedSeed);

    return {
        mnemonic,
        ethAddress: ethWallet.address,
        ethPrivateKey: ethWallet.privateKey,
        solAddress: solanaKeypair.publicKey.toBase58(),
        solPrivateKey: Buffer.from(solanaKeypair.secretKey).toString('hex'),
        balances: { eth: 0.015, sol: 1.45 } // Mocked initial funding for simulation
    };
}

// --- Routes ---

app.get('/', (req, res) => {
    if (req.session.wallet) return res.redirect('/wallet');
    res.render('index', { error: null });
});

app.post('/generate', (req, res) => {
    try {
        const mnemonic = bip39.generateMnemonic();
        req.session.wallet = deriveWalletsFromMnemonic(mnemonic);
        res.redirect('/wallet');
    } catch (error) {
        res.render('index', { error: 'Failed to generate cryptographic seed.' });
    }
});

app.post('/import', (req, res) => {
    try {
        const mnemonic = req.body.mnemonic.trim();
        if (!bip39.validateMnemonic(mnemonic)) throw new Error();
        req.session.wallet = deriveWalletsFromMnemonic(mnemonic);
        res.redirect('/wallet');
    } catch (error) {
        res.render('index', { error: 'INVALID SEED PHRASE.' });
    }
});

app.get('/wallet', (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    // Pass current pool of active public games to the dashboard
    const publicGames = Object.values(activeGames).filter(g => !g.isPrivate && g.status === 'PENDING');
    res.render('wallet', { wallet: req.session.wallet, activeGames: publicGames, error: null, success: null });
});

// --- Betting / Escrow System Endpoints ---

app.post('/trade/host', (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    const { amount, currency, gameType, isPrivate } = req.body;
    const betAmount = parseFloat(amount);
    const userBalance = currency === 'SOL' ? req.session.wallet.balances.sol : req.session.wallet.balances.eth;

    if (betAmount > userBalance) {
        return res.render('wallet', { 
            wallet: req.session.wallet, 
            activeGames: Object.values(activeGames).filter(g => !g.isPrivate),
            error: 'INSUFFICIENT FUNDS FOR AUTHORIZED STAKE.',
            success: null
        });
    }

    // 1. Generate Temporary House Escrow Account
    let escrowAddress = '';
    let escrowPrivateKey = '';

    if (currency === 'SOL') {
        const tempKeypair = Keypair.generate();
        escrowAddress = tempKeypair.publicKey.toBase58();
        escrowPrivateKey = Buffer.from(tempKeypair.secretKey).toString('hex');
    } else {
        const tempWallet = ethers.Wallet.createRandom();
        escrowAddress = tempWallet.address;
        escrowPrivateKey = tempWallet.privateKey;
    }

    // 2. Build unique game instance
    const gameId = crypto.randomBytes(4).toString('hex');
    const accessKey = isPrivate ? crypto.randomBytes(3).toString('hex').toUpperCase() : null;

    activeGames[gameId] = {
        id: gameId,
        hostAddress: currency === 'SOL' ? req.session.wallet.solAddress : req.session.wallet.ethAddress,
        amount: betAmount,
        currency,
        gameType,
        isPrivate: !!isPrivate,
        accessKey,
        escrowAddress,
        escrowPrivateKey,
        status: 'PENDING',
        players: [req.session.wallet.ethAddress]
    };

    // Deduct host's simulated balance for active escrow locking
    if (currency === 'SOL') req.session.wallet.balances.sol -= betAmount;
    else req.session.wallet.balances.eth -= betAmount;

    res.redirect('/wallet');
});

app.post('/trade/join', (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    
    const { gameId, accessKey } = req.body;
    const game = activeGames[gameId] || Object.values(activeGames).find(g => g.accessKey === accessKey?.trim().toUpperCase());

    if (!game || game.status !== 'PENDING') {
        return res.render('wallet', { 
            wallet: req.session.wallet, 
            activeGames: Object.values(activeGames).filter(g => !g.isPrivate),
            error: 'GAME MATRIX SPECIFIED DOES NOT EXIST OR IS ALREADY ACTIVE.',
            success: null
        });
    }

    const userBalance = game.currency === 'SOL' ? req.session.wallet.balances.sol : req.session.wallet.balances.eth;
    if (userBalance < game.amount) {
        return res.render('wallet', { 
            wallet: req.session.wallet, 
            activeGames: Object.values(activeGames).filter(g => !g.isPrivate),
            error: 'INSUFFICIENT BALANCE TO MATCH THE HOSTED STAKE.',
            success: null
        });
    }

    // Deduct challenger's balance
    if (game.currency === 'SOL') req.session.wallet.balances.sol -= game.amount;
    else req.session.wallet.balances.eth -= game.amount;

    // Run simulated game resolution logic
    game.status = 'RESOLVING';
    const totalPool = game.amount * 2;
    const hostWon = Math.random() > 0.5; // True 50/50 resolve framework

    if (hostWon) {
        // In a real configuration, you use game.escrowPrivateKey to send on-chain assets here
        if (game.hostAddress === req.session.wallet.solAddress || game.hostAddress === req.session.wallet.ethAddress) {
            // Host is current user
            if (game.currency === 'SOL') req.session.wallet.balances.sol += totalPool;
            else req.session.wallet.balances.eth += totalPool;
        }
        game.status = 'HOST_WON';
    } else {
        // Challenger (current user) wins
        if (game.currency === 'SOL') req.session.wallet.balances.sol += totalPool;
        else req.session.wallet.balances.eth += totalPool;
        game.status = 'CHALLENGER_WON';
    }

    const winnerMessage = hostWon ? `Game settled. Host claimed pool of ${totalPool} ${game.currency}.` : `Success! You won the game pool of ${totalPool} ${game.currency}!`;
    
    // Clean up game room cache
    delete activeGames[game.id];

    res.render('wallet', { 
        wallet: req.session.wallet, 
        activeGames: Object.values(activeGames).filter(g => !g.isPrivate),
        error: null,
        success: winnerMessage
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(PORT, () => console.log(`[SYSTEM] Core Engine listening on port ${PORT}`));
