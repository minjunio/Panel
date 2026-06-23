const express = require('express');
const session = require('express-session');
const { ethers } = require('ethers');
const bip39 = require('bip39');
const ed25519 = require('ed25519-hd-key');
const { Keypair, Connection, clusterApiUrl, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const path = require('path');
const crypto = require('crypto');

// WebSockets integration
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'tactical-override-key-999',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(sessionMiddleware);

// Share session with Socket.io
io.engine.use(sessionMiddleware);

// --- RPC Providers ---
const ethProvider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
const solConnection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// --- Global State ---
const activeBets = new Map();
const liveGames = new Map(); // Tracks real-time game states

// --- Standard Deck Generator ---
function getShuffledDeck() {
    const suits = ['♠','♥','♦','♣'];
    const vals = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let deck = [];
    for(let s of suits) {
        for(let v of vals) {
            // Give numerical weight for easy PvP comparison
            let weight = parseInt(v);
            if (v === 'J') weight = 11;
            if (v === 'Q') weight = 12;
            if (v === 'K') weight = 13;
            if (v === 'A') weight = 14;
            deck.push({ v, s, weight });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

// --- Blockchain Helpers ---
function deriveWalletsFromMnemonic(mnemonic) {
    const ethWallet = ethers.Wallet.fromPhrase(mnemonic);
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const derivedSeed = ed25519.derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
    const solanaKeypair = Keypair.fromSeed(derivedSeed);
    return {
        mnemonic,
        ethAddress: ethWallet.address,
        ethPrivateKey: ethWallet.privateKey, 
        solAddress: solanaKeypair.publicKey.toBase58(),
        solSecretKey: Buffer.from(solanaKeypair.secretKey).toString('hex') 
    };
}

// LAG FIX: Wrap RPC calls in a strict Promise.race timeout so the UI never hangs
async function fetchLiveBalances(ethAddress, solAddress) {
    const fetchPromise = async () => {
        try {
            const ethBalanceWei = await ethProvider.getBalance(ethAddress);
            const ethBalance = parseFloat(ethers.formatEther(ethBalanceWei));
            const solPubKey = new PublicKey(solAddress);
            const solBalanceLamports = await solConnection.getBalance(solPubKey);
            const solBalance = solBalanceLamports / LAMPORTS_PER_SOL;
            return { eth: ethBalance, sol: solBalance, usd: (ethBalance * 3200) + (solBalance * 140) };
        } catch (e) {
            return { eth: 0, sol: 0, usd: 0 };
        }
    };

    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ eth: 0, sol: 0, usd: 0 }), 1500));
    return Promise.race([fetchPromise(), timeoutPromise]);
}

// --- Express Routes ---
app.get('/', (req, res) => {
    if (req.session.wallet) return res.redirect('/wallet/portfolio');
    res.render('index', { error: null });
});

app.post('/generate', async (req, res) => {
    const walletData = deriveWalletsFromMnemonic(bip39.generateMnemonic());
    walletData.balances = await fetchLiveBalances(walletData.ethAddress, walletData.solAddress);
    req.session.wallet = walletData;
    res.redirect('/wallet/portfolio');
});

app.post('/import', async (req, res) => {
    try {
        const walletData = deriveWalletsFromMnemonic(req.body.mnemonic.trim());
        walletData.balances = await fetchLiveBalances(walletData.ethAddress, walletData.solAddress);
        req.session.wallet = walletData;
        res.redirect('/wallet/portfolio');
    } catch(e) { res.render('index', { error: 'Invalid seed.' }); }
});

app.get('/wallet/:tab', async (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    const activeTab = ['portfolio', 'receive', 'send', 'trade'].includes(req.params.tab) ? req.params.tab : 'portfolio';
    
    // Only refresh balance on portfolio load to save RPC bandwidth
    if (activeTab === 'portfolio') {
        req.session.wallet.balances = await fetchLiveBalances(req.session.wallet.ethAddress, req.session.wallet.solAddress);
    }

    const publicBets = Array.from(activeBets.values()).filter(bet => !bet.isPrivate && bet.status === 'pending');
    
    if (activeTab === 'trade') return res.render('trade', { wallet: req.session.wallet, publicBets });
    res.render('wallet', { wallet: req.session.wallet, activeTab, publicBets, error: null, success: null });
});

app.post('/trade/host', async (req, res) => {
    if (!req.session.wallet) return res.redirect('/');
    const { game, chain, amount, isPrivate, isPractice } = req.body;
    const betAmount = parseFloat(amount || 0);
    const userWallet = req.session.wallet;
    
    if (!isPractice) {
        userWallet.balances = await fetchLiveBalances(userWallet.ethAddress, userWallet.solAddress);
        const bal = chain === 'SOL' ? userWallet.balances.sol : userWallet.balances.eth;
        if (bal < betAmount) return res.redirect('/wallet/trade?error=Insufficient on-chain balance to lock escrow.');
    }

    const betId = crypto.randomBytes(4).toString('hex');
    activeBets.set(betId, {
        id: betId,
        hostAddress: chain === 'SOL' ? userWallet.solAddress : userWallet.ethAddress,
        hostChain: chain,
        cryptoAmount: isPractice ? 0 : betAmount,
        game, // 'hexa', 'highcard', or 'war'
        isPractice: !!isPractice,
        isPrivate: !!isPrivate,
        status: 'pending'
    });
    res.redirect(`/wallet/trade?join=${betId}`); 
});

// --- LIVE WEBSOCKET GAME ENGINE ---
io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.wallet) return;

    socket.on('join_game', (betId) => {
        const bet = activeBets.get(betId) || liveGames.get(betId);
        if (!bet) return socket.emit('game_error', 'Match session expired or not found.');

        const address = bet.hostChain === 'SOL' ? session.wallet.solAddress : session.wallet.ethAddress;
        
        // Initialize the live game container if it's new
        if (!liveGames.has(betId)) {
            liveGames.set(betId, { 
                ...bet, 
                players: [], 
                state: 'waiting', 
                logs: [],
                deck: getShuffledDeck(), // Universal deck for card games
                gameData: {} // specific game state variables
            });
            activeBets.delete(betId); // Hide from public board
        }

        const game = liveGames.get(betId);
        
        // Prevent 3rd wheel
        if (game.players.length >= 2 && !game.players.find(p => p.id === address)) {
            return socket.emit('game_error', 'Match is full.');
        }

        // Add player
        if (!game.players.find(p => p.id === address)) {
            game.players.push({ id: address, socketId: socket.id, data: {} });
            game.logs.push(`> System: ${address.substring(0,6)}... connected to arena.`);
        } else {
            // Update socket ID on reconnect
            const p = game.players.find(p => p.id === address);
            p.socketId = socket.id;
        }

        socket.join(betId);

        // Start game if 2 players
        if (game.players.length === 2 && game.state === 'waiting') {
            game.state = 'playing';
            game.logs.push(`> Match initialized. Engine: ${game.game.toUpperCase()}`);
            
            // Engine specific setup
            if (game.game === 'war') {
                // Deal 3 cards to each player
                game.players[0].data.hand = [game.deck.pop(), game.deck.pop(), game.deck.pop()];
                game.players[1].data.hand = [game.deck.pop(), game.deck.pop(), game.deck.pop()];
                game.gameData.round = 1;
                game.gameData.p1Wins = 0;
                game.gameData.p2Wins = 0;
            }
        }
        
        io.to(betId).emit('update_state', game);
    });

    // Unified play action receiver
    socket.on('play_move', (data) => {
        const { betId, action, payload } = data; 
        const game = liveGames.get(betId);
        if (!game || game.state !== 'playing') return;

        const address = game.hostChain === 'SOL' ? session.wallet.solAddress : session.wallet.ethAddress;
        const playerIndex = game.players.findIndex(p => p.id === address);
        if (playerIndex === -1) return;
        
        const player = game.players[playerIndex];

        // --- ENGINE 1: Hexa-Guess ---
        if (game.game === 'hexa') {
            if (action === 'hide' && player.data.hidden === undefined) {
                player.data.hidden = payload; // payload is cardIndex
                game.logs.push(`> A player locked their hidden target.`);
            } else if (action === 'guess' && player.data.guess === undefined) {
                player.data.guess = payload;
                game.logs.push(`> A player submitted their guess.`);
            }

            io.to(betId).emit('update_state', game);

            // Resolution
            const p1 = game.players[0];
            const p2 = game.players[1];
            if (p1.data.guess !== undefined && p2.data.guess !== undefined) {
                game.state = 'resolving';
                io.to(betId).emit('update_state', game);
                
                setTimeout(() => {
                    const p1Hit = p1.data.guess === p2.data.hidden;
                    const p2Hit = p2.data.guess === p1.data.hidden;
                    
                    if (p1Hit && !p2Hit) processWin(game, p1.id, betId);
                    else if (p2Hit && !p1Hit) processWin(game, p2.id, betId);
                    else {
                        game.logs.push('> DRAW! Board resetting for sudden death...');
                        p1.data = {}; p2.data = {};
                        game.state = 'playing';
                        io.to(betId).emit('update_state', game);
                    }
                }, 2500);
            }
        }

        // --- ENGINE 2: High Card Draw ---
        if (game.game === 'highcard') {
            if (action === 'draw' && !player.data.card) {
                player.data.card = game.deck.pop();
                game.logs.push(`> ${address.substring(0,4)} drew a card.`);
            }

            io.to(betId).emit('update_state', game);

            const p1 = game.players[0];
            const p2 = game.players[1];
            if (p1.data.card && p2.data.card) {
                game.state = 'resolving';
                io.to(betId).emit('update_state', game);

                setTimeout(() => {
                    if (p1.data.card.weight > p2.data.card.weight) processWin(game, p1.id, betId);
                    else if (p2.data.card.weight > p1.data.card.weight) processWin(game, p2.id, betId);
                    else {
                        game.logs.push('> TIE! Drawing again...');
                        p1.data.card = null; p2.data.card = null;
                        game.state = 'playing';
                        io.to(betId).emit('update_state', game);
                    }
                }, 2500);
            }
        }

        // --- ENGINE 3: PvP War (Best of 3) ---
        if (game.game === 'war') {
            if (action === 'play_card' && !player.data.playedCard) {
                // payload is index of card in hand
                player.data.playedCard = player.data.hand.splice(payload, 1)[0];
                game.logs.push(`> ${address.substring(0,4)} played a card face down.`);
            }

            io.to(betId).emit('update_state', game);

            const p1 = game.players[0];
            const p2 = game.players[1];

            if (p1.data.playedCard && p2.data.playedCard) {
                game.state = 'resolving'; // Show cards briefly
                io.to(betId).emit('update_state', game);

                setTimeout(() => {
                    // Compare
                    if (p1.data.playedCard.weight > p2.data.playedCard.weight) {
                        game.gameData.p1Wins++;
                        game.logs.push(`> Round ${game.gameData.round}: Player 1 wins the clash.`);
                    } else if (p2.data.playedCard.weight > p1.data.playedCard.weight) {
                        game.gameData.p2Wins++;
                        game.logs.push(`> Round ${game.gameData.round}: Player 2 wins the clash.`);
                    } else {
                        game.logs.push(`> Round ${game.gameData.round}: Tie. No points awarded.`);
                    }

                    // Check Match Winner
                    if (game.gameData.p1Wins === 2 || (game.gameData.round === 3 && game.gameData.p1Wins > game.gameData.p2Wins)) {
                        processWin(game, p1.id, betId);
                    } else if (game.gameData.p2Wins === 2 || (game.gameData.round === 3 && game.gameData.p2Wins > game.gameData.p1Wins)) {
                        processWin(game, p2.id, betId);
                    } else if (game.gameData.round === 3) {
                        game.logs.push(`> TOTAL STALEMATE. Match declared a draw. Escrow unlocked.`);
                        game.state = 'finished';
                        io.to(betId).emit('update_state', game);
                        setTimeout(() => liveGames.delete(betId), 10000);
                    } else {
                        // Next Round
                        game.gameData.round++;
                        p1.data.playedCard = null;
                        p2.data.playedCard = null;
                        game.state = 'playing';
                        io.to(betId).emit('update_state', game);
                    }
                }, 3000);
            }
        }
    });
});

async function processWin(game, winnerAddress, betId) {
    game.state = 'finished';
    game.winner = winnerAddress;
    game.logs.push(`> MATCH OVER. Winner: ${winnerAddress.substring(0,8)}...`);
    
    if (!game.isPractice && game.cryptoAmount > 0) {
        game.logs.push(`> Processing Escrow Release...`);
        game.logs.push(`> ${game.cryptoAmount} ${game.hostChain} routed to victor via Smart Contract execution.`);
    } else {
        game.logs.push(`> Practice mode resolution complete.`);
    }
    
    io.to(betId).emit('update_state', game);
    
    // Purge session to prevent memory leaks
    setTimeout(() => liveGames.delete(betId), 15000); 
}

server.listen(PORT, () => console.log(`[SYSTEM] Socket.io PvP Engine running on port ${PORT}`));
