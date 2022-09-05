import {buySignalStrikeNotification, sendApeInNotification, startServiceNotification} from "./utils/telegram"
import {tryCatchFinallyUtil} from "./utils/error"
import axios, {AxiosResponse} from "axios"
import {
    BinanceSymbolsResponse, BinanceWebSocketTradeStreamResponse,
    BinanceTelegramSymbols,
    BinanceTelegramWebSocketConnections,
    BinanceTelegramTradingPairs
} from "index"
import {config} from "dotenv"
import {logError} from "./utils/log"
import {sleep} from "./utils/sleep"
import WebSocket from "ws"
import {fixDecimalPlaces} from "./utils/number"

config()

// Global variables
let BINANCE_TELEGRAM_WEB_SOCKET_CONNECTIONS: BinanceTelegramWebSocketConnections = {}
let BINANCE_TELEGRAM_SYMBOLS: BinanceTelegramSymbols = {}
let BINANCE_TELEGRAM_TRADING_PAIRS: BinanceTelegramTradingPairs = {}
let BINANCE_TELEGRAM_TRADE_STREAM_SUBSCRIPTIONS_TRACKER: Record<number, string> = {}
let BINANCE_TELEGRAM_TRADE_STREAM_UNSUBSCRIPTIONS_TRACKER: Record<number, string> = {}
let BINANCE_TELEGRAM_TICKER_STREAM_SUBSCRIPTIONS_TRACKER: Record<number, string> = {}
let BINANCE_TELEGRAM_TICKER_STREAM_UNSUBSCRIPTIONS_TRACKER: Record<number, string> = {}
let BINANCE_TELEGRAM_GET_SYMBOLS_INTERVAL_ID: NodeJS.Timeout

const resetRun = () => {
    BINANCE_TELEGRAM_WEB_SOCKET_CONNECTIONS = {}
    BINANCE_TELEGRAM_SYMBOLS = {}
    BINANCE_TELEGRAM_TRADING_PAIRS = {}
    BINANCE_TELEGRAM_TRADE_STREAM_SUBSCRIPTIONS_TRACKER = {}
    BINANCE_TELEGRAM_TRADE_STREAM_UNSUBSCRIPTIONS_TRACKER = {}
    BINANCE_TELEGRAM_TICKER_STREAM_SUBSCRIPTIONS_TRACKER = {}
    BINANCE_TELEGRAM_TICKER_STREAM_UNSUBSCRIPTIONS_TRACKER = {}

    clearInterval(BINANCE_TELEGRAM_GET_SYMBOLS_INTERVAL_ID)
    run()
}

const getSymbolsData = () => {
    tryCatchFinallyUtil(
        () => {
            axios.get(`${process.env.BINANCE_REST_BASE_URL}/api/v3/exchangeInfo`)
                .then((response: AxiosResponse<BinanceSymbolsResponse>) => {
                    // Initial at startup
                    if (Object.entries(BINANCE_TELEGRAM_SYMBOLS).length === 0) {
                        for (let a = 0; a < response.data.symbols.length; a++) {
                            const tradePair = response.data.symbols[a]
                            const {baseAsset, quoteAsset} = tradePair
                            if (BINANCE_TELEGRAM_SYMBOLS[baseAsset]) {
                                BINANCE_TELEGRAM_SYMBOLS[baseAsset] = {
                                    ...BINANCE_TELEGRAM_SYMBOLS[baseAsset],
                                    [quoteAsset]: tradePair
                                }
                            } else {
                                BINANCE_TELEGRAM_SYMBOLS[baseAsset] = {
                                    [quoteAsset]: tradePair
                                }
                            }
                        }
                        processTradingPairs()
                    }
                    // Subsequent (Post-startup)
                    else {
                        const newBinanceSymbols: BinanceTelegramSymbols = {}
                        for (let a = 0; a < response.data.symbols.length; a++) {
                            const tradePair = response.data.symbols[a]
                            const {baseAsset, quoteAsset} = tradePair
                            if (!BINANCE_TELEGRAM_SYMBOLS[baseAsset]) {
                                if (BINANCE_TELEGRAM_SYMBOLS[baseAsset]) {
                                    BINANCE_TELEGRAM_SYMBOLS[baseAsset] = {
                                        ...BINANCE_TELEGRAM_SYMBOLS[baseAsset],
                                        [quoteAsset]: tradePair
                                    }
                                } else {
                                    BINANCE_TELEGRAM_SYMBOLS[baseAsset] = {
                                        [quoteAsset]: tradePair
                                    }
                                }
                            }
                        }

                        const deleteBinanceSymbols: BinanceTelegramSymbols = {}
                        const apiBinanceSymbols: BinanceTelegramSymbols = {}
                        for (let a = 0; a < response.data.symbols.length; a++) {
                            const tradePair = response.data.symbols[a]
                            const {baseAsset, quoteAsset} = tradePair
                            if (apiBinanceSymbols[baseAsset]) {
                                apiBinanceSymbols[baseAsset] = {
                                    ...apiBinanceSymbols[baseAsset],
                                    [quoteAsset]: tradePair
                                }
                            } else {
                                apiBinanceSymbols[baseAsset] = {
                                    [quoteAsset]: tradePair
                                }
                            }
                        }
                        const rgTraderBinanceSymbolsEntries: Array<[string, BinanceTelegramSymbols[""]]> = Object.entries(BINANCE_TELEGRAM_SYMBOLS)

                        for (let a = 0; a < rgTraderBinanceSymbolsEntries.length; a++) {
                            const [baseCurrency, tradePair] = rgTraderBinanceSymbolsEntries[a]
                            if (!apiBinanceSymbols[baseCurrency]) {
                                deleteBinanceSymbols[baseCurrency] = tradePair
                            } else {
                                if (BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency]) {
                                    if (!apiBinanceSymbols[baseCurrency][BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].quoteCurrency]) {
                                        deleteBinanceSymbols[baseCurrency] = tradePair
                                    } else {
                                        if (apiBinanceSymbols[baseCurrency][BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].quoteCurrency].status !== "TRADING") {
                                            deleteBinanceSymbols[baseCurrency] = tradePair
                                        }
                                    }
                                }
                            }
                        }

                        BINANCE_TELEGRAM_SYMBOLS = {...apiBinanceSymbols}

                        processTradingPairs(newBinanceSymbols, deleteBinanceSymbols)
                    }
                })
                .catch((e) => {
                    logError(`getSymbolsData.axios() - ${e}`)
                    getSymbolsData()
                })
        },
        (e) => {
            logError(`getSymbolsData() - ${e}`)
            getSymbolsData()
        }
    )
}

const processTradingPairs = (newSubscribeSymbols ?: BinanceTelegramSymbols, unsubscribeSymbols ?: BinanceTelegramSymbols) => {
    tryCatchFinallyUtil(async () => {
        const markets: string[] = `${process.env.BINANCE_QUOTE_ASSETS}`.split(",")
        const maximumWebSocketSubscriptions: number = Number(`${process.env.BINANCE_MAX_SUBSCRIPTIONS_PER_WEB_SOCKET}`) / 2
        const rgBinanceSymbolEntries = Object.entries(BINANCE_TELEGRAM_SYMBOLS)
        for (let a = 0; a < markets.length; a++) {
            const quoteCurrency: string = markets[a]
            for (let b = 0; b < rgBinanceSymbolEntries.length; b++) {
                const [baseCurrency, value] = rgBinanceSymbolEntries[b]
                if (!BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency]) {
                    if (BINANCE_TELEGRAM_SYMBOLS[baseCurrency][quoteCurrency]) {
                        const tradePair = value[quoteCurrency]
                        if (tradePair.status === "TRADING") {
                            BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency] = {
                                webSocketConnectionId: "",
                                symbol: tradePair.symbol,
                                baseCurrency,
                                quoteCurrency,
                                baseDecimalPlaces: tradePair.baseAssetPrecision,
                                quoteDecimalPlaces: tradePair.quoteAssetPrecision,
                                tradeStreamSubscriptionAckInterval: undefined,
                                tradeStreamUnsubscriptionAckInterval: undefined,
                                tickerStreamSubscriptionAckInterval: undefined,
                                tickerStreamUnsubscriptionAckInterval: undefined,
                                notificationStrikeCount: 0,
                                notificationStrikeTimeoutId: undefined,
                                notificationBuyPrice: 0,
                                notificationStrikeUnitPrice: 0,
                                apeInPercentage: Number(process.env.APE_IN_START_PERCENTAGE),
                                apeInTimeoutId: undefined
                            }
                        }
                    }
                }
            }
        }

        // Initial at startup
        if (!newSubscribeSymbols && !unsubscribeSymbols) {
            const rgTradingPairsArray: [string, BinanceTelegramTradingPairs[""]][] = Object.entries(BINANCE_TELEGRAM_TRADING_PAIRS)
            const totalTradingPairsCount: number = rgTradingPairsArray.length
            const totalWebSocketConnectionsCount: number = Math.ceil(totalTradingPairsCount / maximumWebSocketSubscriptions)

            for (let a = 0; a < totalWebSocketConnectionsCount; a++) {
                const rgTradingPairsForSubscription: [string, BinanceTelegramTradingPairs[""]][] = rgTradingPairsArray.slice(
                    a * maximumWebSocketSubscriptions, (a * maximumWebSocketSubscriptions) + maximumWebSocketSubscriptions
                )
                openWebSocketConnection(rgTradingPairsForSubscription)
            }
        }
        // Subsequent
        else {
            const unsubscribeSymbolsEntries: [string, BinanceTelegramSymbols[""]][] = Object.entries(unsubscribeSymbols)
            if (unsubscribeSymbolsEntries.length > 0) {
                const handleTradingPairUnsubscription = (webSocketConnectionId: string, baseCurrency: string, tradePair: BinanceTelegramTradingPairs[""], streamType: 'ticker' | 'trade') => {
                    const unsubscriptionId: number = new Date().getTime()
                    const request = {
                        method: "UNSUBSCRIBE",
                        params: [`${tradePair.symbol.toLowerCase()}@${streamType}`],
                        id: unsubscriptionId
                    }
                    // Unsubscribe
                    BINANCE_TELEGRAM_WEB_SOCKET_CONNECTIONS[webSocketConnectionId].webSocket.send(JSON.stringify(request))

                    if (streamType === 'trade') BINANCE_TELEGRAM_TRADE_STREAM_UNSUBSCRIPTIONS_TRACKER[unsubscriptionId] = baseCurrency
                    if (streamType === 'ticker') BINANCE_TELEGRAM_TICKER_STREAM_UNSUBSCRIPTIONS_TRACKER[unsubscriptionId] = baseCurrency
                }

                for (let a = 0; a < unsubscribeSymbolsEntries.length; a++) {
                    const [baseCurrency] = unsubscribeSymbolsEntries[a]
                    const tradePair: BinanceTelegramTradingPairs[""] = BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency]

                    handleTradingPairUnsubscription(tradePair.webSocketConnectionId, baseCurrency, tradePair, 'trade')

                    BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].tradeStreamUnsubscriptionAckInterval = setInterval(() => {
                        const previousUnsubscriptionId: number = Number(Object.entries(BINANCE_TELEGRAM_TRADE_STREAM_UNSUBSCRIPTIONS_TRACKER).filter(([_, v]) => v === baseCurrency)[0][0])
                        delete BINANCE_TELEGRAM_TRADE_STREAM_UNSUBSCRIPTIONS_TRACKER[previousUnsubscriptionId]

                        handleTradingPairUnsubscription(tradePair.webSocketConnectionId, baseCurrency, tradePair, 'trade')
                    }, Math.floor(1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)) * Object.entries(BINANCE_TELEGRAM_TRADING_PAIRS).length)

                    await sleep(Math.floor(
                        1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)
                    ))
                }

                for (let a = 0; a < unsubscribeSymbolsEntries.length; a++) {
                    const [baseCurrency] = unsubscribeSymbolsEntries[a]
                    const tradePair: BinanceTelegramTradingPairs[""] = BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency]

                    handleTradingPairUnsubscription(tradePair.webSocketConnectionId, baseCurrency, tradePair, 'ticker')

                    BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].tickerStreamUnsubscriptionAckInterval = setInterval(() => {
                        const previousUnsubscriptionId: number = Number(Object.entries(BINANCE_TELEGRAM_TICKER_STREAM_UNSUBSCRIPTIONS_TRACKER).filter(([_, v]) => v === baseCurrency)[0][0])
                        delete BINANCE_TELEGRAM_TICKER_STREAM_UNSUBSCRIPTIONS_TRACKER[previousUnsubscriptionId]

                        handleTradingPairUnsubscription(tradePair.webSocketConnectionId, baseCurrency, tradePair, 'ticker')
                    }, Math.floor(1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)) * Object.entries(BINANCE_TELEGRAM_TRADING_PAIRS).length)

                    await sleep(Math.floor(
                        1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)
                    ))
                }
            }

            const newSubscribeSymbolsEntries: [string, BinanceTelegramSymbols[""]][] = Object.entries(newSubscribeSymbols)
            if (newSubscribeSymbolsEntries.length > 0) {
                for (let a = 0; a < newSubscribeSymbolsEntries.length; a++) {
                    const [baseCurrency] = newSubscribeSymbolsEntries[a]
                    const tradePair: BinanceTelegramTradingPairs[""] = BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency]
                    const websockets: [string, BinanceTelegramWebSocketConnections[""]][] = Object.entries(BINANCE_TELEGRAM_WEB_SOCKET_CONNECTIONS)

                    if (tradePair) {
                        for (let b = 0; b < websockets.length; b++) {
                            const [webSocketConnectionId, websocket] = websockets[b]
                            if (!(websocket.numberOfActiveSubscriptions === maximumWebSocketSubscriptions)) {
                                let subscriptionId: number = new Date().getTime()
                                let request = {
                                    method: "SUBSCRIBE",
                                    params: [`${tradePair.symbol.toLowerCase()}@trade`],
                                    id: subscriptionId
                                }
                                // Subscribe - trade stream
                                BINANCE_TELEGRAM_WEB_SOCKET_CONNECTIONS[webSocketConnectionId].webSocket.send(JSON.stringify(request))

                                subscriptionId = new Date().getTime()
                                request = {
                                    method: "SUBSCRIBE",
                                    params: [`${tradePair.symbol.toLowerCase()}@ticker`],
                                    id: subscriptionId
                                }
                                // Subscribe - ticker stream
                                BINANCE_TELEGRAM_WEB_SOCKET_CONNECTIONS[webSocketConnectionId].webSocket.send(JSON.stringify(request))

                                BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].webSocketConnectionId = webSocketConnectionId
                                BINANCE_TELEGRAM_WEB_SOCKET_CONNECTIONS[webSocketConnectionId].numberOfActiveSubscriptions += 1

                                delete newSubscribeSymbols[baseCurrency]

                                await sleep(Math.floor(1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)) * 3)

                                break
                            }
                        }
                    }

                    if (newSubscribeSymbols[baseCurrency]) {
                        break
                    }
                }

                // Initiate subscriptions of unsubscribed new symbols
                const rgTradingPairsArray: [string, BinanceTelegramTradingPairs[""]][] = Object.entries(BINANCE_TELEGRAM_TRADING_PAIRS).filter(([key]) => !!newSubscribeSymbols[key])
                const totalTradingPairsCount: number = rgTradingPairsArray.length
                const totalWebSocketConnectionsCount: number = Math.ceil(totalTradingPairsCount / maximumWebSocketSubscriptions)
                for (let a = 0; a < totalWebSocketConnectionsCount; a++) {
                    const rgTradingPairsForSubscription: [string, BinanceTelegramTradingPairs[""]][] = rgTradingPairsArray.slice(
                        a * maximumWebSocketSubscriptions, (a * maximumWebSocketSubscriptions) + maximumWebSocketSubscriptions
                    )
                    openWebSocketConnection(rgTradingPairsForSubscription)
                }
            }
        }
    }, (e) => {
        logError(`processTradingPairs() - ${e}`)
        resetRun()
    })
}

const getBaseAssetName = (tradingPair: string) => {
    const regExp: RegExp = new RegExp(`^(\\w+)(` + process.env.BINANCE_QUOTE_ASSETS.replace(/,/g,"|") + `)$`)
    return tradingPair.replace(regExp, '$1')
}
const openWebSocketConnection = (rgTradingPairs: [string, BinanceTelegramTradingPairs[""]][]) => {
    const webSocketConnectionId: string = `${new Date().getTime()}.${Math.random()}`
    tryCatchFinallyUtil(() => {
        const webSocket: WebSocket = new WebSocket(`${process.env.BINANCE_WEBSOCKET_URL}/stream`)

        BINANCE_TELEGRAM_WEB_SOCKET_CONNECTIONS[webSocketConnectionId] = {
            webSocket,
            numberOfActiveSubscriptions: 0
        }

        const handleTradingPairSubscription = (baseCurrency: string, tradingPair: BinanceTelegramTradingPairs[""], streamType: 'ticker' | 'trade') => {
            const subscriptionId: number = new Date().getTime()
            const request = {
                method: "SUBSCRIBE",
                params: [`${tradingPair.symbol.toLowerCase()}@${streamType}`],
                id: subscriptionId
            }
            // Subscribe
            webSocket.send(JSON.stringify(request))

            if (streamType === 'trade') BINANCE_TELEGRAM_TRADE_STREAM_SUBSCRIPTIONS_TRACKER[subscriptionId] = baseCurrency
            if (streamType === 'ticker') BINANCE_TELEGRAM_TICKER_STREAM_SUBSCRIPTIONS_TRACKER[subscriptionId] = baseCurrency
        }

        let pingTimeoutId: NodeJS.Timeout
        const clearPingTimeoutId = () => {
            if (pingTimeoutId) {
                clearTimeout(pingTimeoutId)
                pingTimeoutId = undefined
            }
        }
        const heartBeat = (websocket: WebSocket) => {
            clearPingTimeoutId()
            pingTimeoutId = setTimeout(() => {
                websocket.terminate()
            }, Number(process.env.BINANCE_WEB_SOCKET_PING_TIMEOUT_MINS) * 60 * 1000) as NodeJS.Timeout
        }

        webSocket.on('ping', () => {
            // tslint:disable-next-line:no-empty
            webSocket.pong(() => {
            })
            heartBeat(webSocket)
        })

        webSocket.on("open", async () => {
            heartBeat(webSocket)

            for (let a = 0; a < rgTradingPairs.length; a++) {
                const [baseCurrency, rgTradePair] = rgTradingPairs[a]

                if (BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency]) {
                    handleTradingPairSubscription(baseCurrency, rgTradePair, 'trade')

                    BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].tradeStreamSubscriptionAckInterval = setInterval(() => {
                        if (Object.entries(BINANCE_TELEGRAM_TRADE_STREAM_SUBSCRIPTIONS_TRACKER).filter(([_, v]) => v === baseCurrency)[0]) {
                            const previousSubscriptionId: number = Number(Object.entries(BINANCE_TELEGRAM_TRADE_STREAM_SUBSCRIPTIONS_TRACKER).filter(([_, v]) => v === baseCurrency)[0][0])
                            delete BINANCE_TELEGRAM_TRADE_STREAM_SUBSCRIPTIONS_TRACKER[previousSubscriptionId]
                        }

                        handleTradingPairSubscription(baseCurrency, rgTradePair, 'trade')
                    }, Math.floor(1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)) * rgTradingPairs.length)

                    await sleep(Math.floor(
                        1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)
                    ))
                }
            }

            for (let a = 0; a < rgTradingPairs.length; a++) {
                const [baseCurrency, rgTradePair] = rgTradingPairs[a]

                if (BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency]) {
                    handleTradingPairSubscription(baseCurrency, rgTradePair, 'ticker')

                    BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].tickerStreamSubscriptionAckInterval = setInterval(() => {
                        if (Object.entries(BINANCE_TELEGRAM_TICKER_STREAM_SUBSCRIPTIONS_TRACKER).filter(([_, v]) => v === baseCurrency)[0]) {
                            const previousSubscriptionId: number = Number(Object.entries(BINANCE_TELEGRAM_TICKER_STREAM_SUBSCRIPTIONS_TRACKER).filter(([_, v]) => v === baseCurrency)[0][0])
                            delete BINANCE_TELEGRAM_TICKER_STREAM_SUBSCRIPTIONS_TRACKER[previousSubscriptionId]
                        }

                        handleTradingPairSubscription(baseCurrency, rgTradePair, 'ticker')
                    }, Math.floor(1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)) * rgTradingPairs.length)

                    await sleep(Math.floor(
                        1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)
                    ))
                }
            }
        })

        webSocket.on("message", (data) => {
            const response: BinanceWebSocketTradeStreamResponse = JSON.parse(data.toString())
            // Subscriptions and Unsubscriptions
            if (response.id && response.result === null) {
                if (BINANCE_TELEGRAM_TRADE_STREAM_SUBSCRIPTIONS_TRACKER[response.id]) {
                    BINANCE_TELEGRAM_TRADING_PAIRS[BINANCE_TELEGRAM_TRADE_STREAM_SUBSCRIPTIONS_TRACKER[response.id]].webSocketConnectionId = webSocketConnectionId
                    BINANCE_TELEGRAM_WEB_SOCKET_CONNECTIONS[webSocketConnectionId].numberOfActiveSubscriptions += 1

                    clearInterval(BINANCE_TELEGRAM_TRADING_PAIRS[BINANCE_TELEGRAM_TRADE_STREAM_SUBSCRIPTIONS_TRACKER[response.id]].tradeStreamSubscriptionAckInterval)
                    BINANCE_TELEGRAM_TRADING_PAIRS[BINANCE_TELEGRAM_TRADE_STREAM_SUBSCRIPTIONS_TRACKER[response.id]].tradeStreamSubscriptionAckInterval = undefined

                    delete BINANCE_TELEGRAM_TRADE_STREAM_SUBSCRIPTIONS_TRACKER[response.id]
                }

                if (BINANCE_TELEGRAM_TRADE_STREAM_UNSUBSCRIPTIONS_TRACKER[response.id]) {
                    BINANCE_TELEGRAM_WEB_SOCKET_CONNECTIONS[webSocketConnectionId].numberOfActiveSubscriptions -= 1
                    clearInterval(BINANCE_TELEGRAM_TRADING_PAIRS[BINANCE_TELEGRAM_TRADE_STREAM_UNSUBSCRIPTIONS_TRACKER[response.id]].tradeStreamUnsubscriptionAckInterval)
                    BINANCE_TELEGRAM_TRADING_PAIRS[BINANCE_TELEGRAM_TRADE_STREAM_UNSUBSCRIPTIONS_TRACKER[response.id]].tradeStreamUnsubscriptionAckInterval = undefined

                    delete BINANCE_TELEGRAM_TRADE_STREAM_UNSUBSCRIPTIONS_TRACKER[response.id]
                }

                if (BINANCE_TELEGRAM_TICKER_STREAM_SUBSCRIPTIONS_TRACKER[response.id]) {
                    clearInterval(BINANCE_TELEGRAM_TRADING_PAIRS[BINANCE_TELEGRAM_TICKER_STREAM_SUBSCRIPTIONS_TRACKER[response.id]].tickerStreamSubscriptionAckInterval)
                    BINANCE_TELEGRAM_TRADING_PAIRS[BINANCE_TELEGRAM_TICKER_STREAM_SUBSCRIPTIONS_TRACKER[response.id]].tickerStreamSubscriptionAckInterval = undefined

                    delete BINANCE_TELEGRAM_TICKER_STREAM_SUBSCRIPTIONS_TRACKER[response.id]
                }

                if (BINANCE_TELEGRAM_TICKER_STREAM_UNSUBSCRIPTIONS_TRACKER[response.id]) {
                    clearInterval(BINANCE_TELEGRAM_TRADING_PAIRS[BINANCE_TELEGRAM_TICKER_STREAM_UNSUBSCRIPTIONS_TRACKER[response.id]].tickerStreamUnsubscriptionAckInterval)
                    BINANCE_TELEGRAM_TRADING_PAIRS[BINANCE_TELEGRAM_TICKER_STREAM_UNSUBSCRIPTIONS_TRACKER[response.id]].tickerStreamUnsubscriptionAckInterval = undefined

                    delete BINANCE_TELEGRAM_TRADING_PAIRS[BINANCE_TELEGRAM_TICKER_STREAM_UNSUBSCRIPTIONS_TRACKER[response.id]]
                    delete BINANCE_TELEGRAM_TICKER_STREAM_UNSUBSCRIPTIONS_TRACKER[response.id]
                }
            }
            // Trades
            else {
                const tradingPair: BinanceTelegramTradingPairs[""] = BINANCE_TELEGRAM_TRADING_PAIRS[getBaseAssetName(response.data.s)]
                if (tradingPair) {
                    const {baseCurrency, quoteCurrency} = tradingPair
                    if (response.data.e === "trade") {
                        // Notification service
                        const newNotificationBuyPrice: number = tradingPair.notificationStrikeCount === 0 ?
                            fixDecimalPlaces((1.00 + Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) * Number(response.data.p), tradingPair.quoteDecimalPlaces) :
                            fixDecimalPlaces(tradingPair.notificationBuyPrice + tradingPair.notificationStrikeUnitPrice, tradingPair.quoteDecimalPlaces)

                        if (tradingPair.notificationBuyPrice) {
                            if (newNotificationBuyPrice < tradingPair.notificationBuyPrice) {
                                BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationBuyPrice = newNotificationBuyPrice
                            }
                        } else {
                            BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationBuyPrice = newNotificationBuyPrice
                        }

                        if (Number(response.data.p) >= tradingPair.notificationBuyPrice && tradingPair.notificationBuyPrice !== 0) {
                            BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeCount += 1
                            if (BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeCount === 1) {
                                BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeUnitPrice = fixDecimalPlaces((tradingPair.notificationBuyPrice * Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) / (1.00 + Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT)), tradingPair.quoteDecimalPlaces)
                            }

                            if (BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeCount > 1) buySignalStrikeNotification(response.data.s, fixDecimalPlaces(Number(response.data.p), tradingPair.quoteDecimalPlaces), BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeCount, Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT), quoteCurrency)

                            if (tradingPair.notificationStrikeTimeoutId) clearTimeout(tradingPair.notificationStrikeTimeoutId)
                            BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeTimeoutId = setTimeout(
                                () => {
                                    BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeCount = 0
                                    BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationBuyPrice = 0
                                    BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeUnitPrice = 0

                                    clearTimeout(BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeTimeoutId)
                                    BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeTimeoutId = undefined
                                }, 1000 * 60 * Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_TIMEOUT_MINS) * BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeCount
                            ) as NodeJS.Timeout
                            BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationBuyPrice = BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationBuyPrice + BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].notificationStrikeUnitPrice
                        }
                    }

                    if (response.data.e === "24hrTicker") {
                        // APE IN service
                        const percentChange: number = Math.round(((Number(response.data.c) - Number(response.data.h)) / Number(response.data.h)) * 10000) / 100
                        if ((percentChange < tradingPair.apeInPercentage)) {
                            // Send notification
                            sendApeInNotification(response.data.s, percentChange)

                            // Set next percentage
                            BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].apeInPercentage = tradingPair.apeInPercentage + Number(process.env.APE_IN_INCREMENT_PERCENTAGE)
                            if (tradingPair.apeInTimeoutId) {
                                clearTimeout(tradingPair.apeInTimeoutId)
                            }
                            BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].apeInTimeoutId = setTimeout(() => {
                                // Reset notification percentage
                                BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].apeInPercentage = Number(process.env.APE_IN_START_PERCENTAGE)

                                clearTimeout(BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].apeInTimeoutId)
                                BINANCE_TELEGRAM_TRADING_PAIRS[baseCurrency].apeInTimeoutId = undefined
                            }, 1000 * 60 * 60 * Number(process.env.APE_IN_PERCENT_TIMEOUT_HRS))
                        }
                    }
                }
            }
        })

        webSocket.on('error', (error => {
            logError(`openWebSocketConnection().webSocket.error() - ${error}`)
            webSocket.terminate()
        }))

        webSocket.on('close', ((code, reason) => {
            logError(`openWebSocketConnection().webSocket.close() - ${code} => ${reason}`)
            clearPingTimeoutId()

            delete BINANCE_TELEGRAM_WEB_SOCKET_CONNECTIONS[webSocketConnectionId]
            if (rgTradingPairs.length > Object.entries(BINANCE_TELEGRAM_TRADING_PAIRS).filter(([_, v]) => v.webSocketConnectionId === webSocketConnectionId).length) {
                openWebSocketConnection(rgTradingPairs)
            } else {
                openWebSocketConnection(Object.entries(BINANCE_TELEGRAM_TRADING_PAIRS).filter(([_, v]) => v.webSocketConnectionId === webSocketConnectionId))
            }
        }))
    }, (e) => {
        logError(`openWebSocketConnection() - ${e}`)
        if (rgTradingPairs.length > Object.entries(BINANCE_TELEGRAM_TRADING_PAIRS).filter(([_, v]) => v.webSocketConnectionId === webSocketConnectionId).length) {
            openWebSocketConnection(rgTradingPairs)
        } else {
            openWebSocketConnection(Object.entries(BINANCE_TELEGRAM_TRADING_PAIRS).filter(([_, v]) => v.webSocketConnectionId === webSocketConnectionId))
        }
    })
}

// Run!
const run = () => {
    startServiceNotification()

    getSymbolsData()

    BINANCE_TELEGRAM_GET_SYMBOLS_INTERVAL_ID = setInterval(() => {
        getSymbolsData()
    }, 1000 * 60 * Number(process.env.BINANCE_SYMBOL_UPDATE_INTERVAL_MINS)) // Every 10min update our symbols. In case of new listings.
}

run()