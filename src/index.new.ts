import {buySignalStrikeNotification, sendApeInNotification, startServiceNotification} from "./utils/telegram"
import {tryCatchFinallyUtil} from "./utils/error";
import axios, {AxiosResponse} from "axios";
import {
    BinanceSymbolsResponse, BinanceWebSocketTickerArrStreamResponse, BinanceWebSocketTradeStreamResponse,
    RGTraderBinanceSymbols,
    RGTraderBinanceWebSocketConnections,
    RGTraderTradingPairs
} from "index";
import {config} from "dotenv";
import {logError} from "./utils/log";
import {sleep} from "./utils/sleep";
import WebSocket from "ws";
import {fixDecimalPlaces} from "./utils/number";
import Websocket from "ws";

config()

// Global variables
let RG_TRADER_WEB_SOCKET_CONNECTIONS: RGTraderBinanceWebSocketConnections = {}
let RG_TRADER_BINANCE_SYMBOLS: RGTraderBinanceSymbols = {}
let RG_TRADER_TRADING_PAIRS: RGTraderTradingPairs = {}
let RG_SUBSCRIPTIONS_TRACKER: Record<number, string> = {}
let RG_UNSUBSCRIPTIONS_TRACKER: Record<number, string> = {}
let RG_TRADER_GET_SYMBOLS_INTERVAL_ID: NodeJS.Timeout
const APE_IN_SYMBOLS: {
    [symbol: string]: {
        percentage: number
        timeoutId: NodeJS.Timeout
    }
} = {}

const resetRun = () => {
    RG_TRADER_WEB_SOCKET_CONNECTIONS = {}
    RG_TRADER_BINANCE_SYMBOLS = {}
    RG_TRADER_TRADING_PAIRS = {}
    RG_SUBSCRIPTIONS_TRACKER = {}
    RG_UNSUBSCRIPTIONS_TRACKER = {}

    clearInterval(RG_TRADER_GET_SYMBOLS_INTERVAL_ID)
    run()
}

const getSymbolsData = () => {
    tryCatchFinallyUtil(
        () => {
            axios.get(`${process.env.BINANCE_REST_BASE_URL}/api/v3/exchangeInfo`)
                .then((response: AxiosResponse<BinanceSymbolsResponse>) => {
                    // Initial at startup
                    if (Object.entries(RG_TRADER_BINANCE_SYMBOLS).length === 0) {
                        for (let a = 0; a < response.data.symbols.length; a++) {
                            const tradePair = response.data.symbols[a]
                            const {baseAsset, quoteAsset} = tradePair
                            if (RG_TRADER_BINANCE_SYMBOLS[baseAsset]) {
                                RG_TRADER_BINANCE_SYMBOLS[baseAsset] = {
                                    ...RG_TRADER_BINANCE_SYMBOLS[baseAsset],
                                    [quoteAsset]: tradePair
                                }
                            } else {
                                RG_TRADER_BINANCE_SYMBOLS[baseAsset] = {
                                    [quoteAsset]: tradePair
                                }
                            }
                        }
                        processTradingPairs()
                    }
                    // Subsequent (Post-startup)
                    else {
                        const newBinanceSymbols: RGTraderBinanceSymbols = {}
                        for (let a = 0; a < response.data.symbols.length; a++) {
                            const tradePair = response.data.symbols[a]
                            const {baseAsset, quoteAsset} = tradePair
                            if (!RG_TRADER_BINANCE_SYMBOLS[baseAsset]) {
                                if (RG_TRADER_BINANCE_SYMBOLS[baseAsset]) {
                                    RG_TRADER_BINANCE_SYMBOLS[baseAsset] = {
                                        ...RG_TRADER_BINANCE_SYMBOLS[baseAsset],
                                        [quoteAsset]: tradePair
                                    }
                                } else {
                                    RG_TRADER_BINANCE_SYMBOLS[baseAsset] = {
                                        [quoteAsset]: tradePair
                                    }
                                }
                            }
                        }

                        const deleteBinanceSymbols: RGTraderBinanceSymbols = {}
                        const apiBinanceSymbols: RGTraderBinanceSymbols = {}
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
                        const rgTraderBinanceSymbolsEntries: Array<[string, RGTraderBinanceSymbols[""]]> = Object.entries(RG_TRADER_BINANCE_SYMBOLS)

                        for (let a = 0; a < rgTraderBinanceSymbolsEntries.length; a++) {
                            const [baseCurrency, tradePair] = rgTraderBinanceSymbolsEntries[a]
                            if (!apiBinanceSymbols[baseCurrency]) {
                                deleteBinanceSymbols[baseCurrency] = tradePair
                            } else {
                                if (RG_TRADER_TRADING_PAIRS[baseCurrency]) {
                                    if (!apiBinanceSymbols[baseCurrency][RG_TRADER_TRADING_PAIRS[baseCurrency].quoteCurrency]) {
                                        deleteBinanceSymbols[baseCurrency] = tradePair
                                    } else {
                                        if (apiBinanceSymbols[baseCurrency][RG_TRADER_TRADING_PAIRS[baseCurrency].quoteCurrency].status !== "TRADING") {
                                            deleteBinanceSymbols[baseCurrency] = tradePair
                                        }
                                    }
                                }
                            }
                        }

                        RG_TRADER_BINANCE_SYMBOLS = {...apiBinanceSymbols}

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

const processTradingPairs = (newSubscribeSymbols ?: RGTraderBinanceSymbols, unsubscribeSymbols ?: RGTraderBinanceSymbols) => {
    tryCatchFinallyUtil(async () => {
        const markets: string[] = `${process.env.BINANCE_QUOTE_ASSETS}`.split(",")
        const maximumWebSocketSubscriptions: number = Number(`${process.env.BINANCE_MAX_SUBSCRIPTIONS_PER_WEB_SOCKET}`)
        const rgBinanceSymbolEntries = Object.entries(RG_TRADER_BINANCE_SYMBOLS)
        for (let a = 0; a < markets.length; a++) {
            const quoteCurrency: string = markets[a]
            for (let b = 0; b < rgBinanceSymbolEntries.length; b++) {
                const [baseCurrency, value] = rgBinanceSymbolEntries[b]
                if (!RG_TRADER_TRADING_PAIRS[baseCurrency]) {
                    if (RG_TRADER_BINANCE_SYMBOLS[baseCurrency][quoteCurrency]) {
                        const tradePair = value[quoteCurrency]
                        if (tradePair.status === "TRADING") {
                            RG_TRADER_TRADING_PAIRS[baseCurrency] = {
                                webSocketConnectionId: "",
                                symbol: tradePair.symbol,
                                baseCurrency,
                                quoteCurrency,
                                baseDecimalPlaces: tradePair.baseAssetPrecision,
                                quoteDecimalPlaces: tradePair.quoteAssetPrecision,
                                subscriptionAckInterval: undefined,
                                unsubscriptionAckInterval: undefined,
                                notificationStrikeCount: 0,
                                notificationStrikeTimeoutId: undefined,
                                notificationBuyPrice: 0,
                                notificationStrikeUnitPrice: 0
                            }
                            APE_IN_SYMBOLS[tradePair.symbol] = {
                                percentage: Number(process.env.APE_IN_START_PERCENTAGE),
                                timeoutId: undefined
                            }
                        }
                    }
                }
            }
        }

        // Initial at startup
        if (!newSubscribeSymbols && !unsubscribeSymbols) {
            const rgTradingPairsArray: [string, RGTraderTradingPairs[""]][] = Object.entries(RG_TRADER_TRADING_PAIRS)
            const totalTradingPairsCount: number = rgTradingPairsArray.length
            const totalWebSocketConnectionsCount: number = Math.ceil(totalTradingPairsCount / maximumWebSocketSubscriptions)

            for (let a = 0; a < totalWebSocketConnectionsCount; a++) {
                const rgTradingPairsForSubscription: [string, RGTraderTradingPairs[""]][] = rgTradingPairsArray.slice(
                    a * maximumWebSocketSubscriptions, (a * maximumWebSocketSubscriptions) + maximumWebSocketSubscriptions
                )
                openWebSocketConnection(rgTradingPairsForSubscription)
            }
        }
        // Subsequent
        else {
            const unsubscribeSymbolsEntries: [string, RGTraderBinanceSymbols[""]][] = Object.entries(unsubscribeSymbols)
            if (unsubscribeSymbolsEntries.length > 0) {
                const handleTradingPairUnsubscription = (webSocketConnectionId: string, baseCurrency: string, tradePair: RGTraderTradingPairs[""]) => {
                    const unsubscriptionId: number = new Date().getTime()
                    const request = {
                        method: "UNSUBSCRIBE",
                        params: [`${tradePair.symbol.toLowerCase()}@trade`],
                        id: unsubscriptionId
                    }
                    // Unsubscribe
                    RG_TRADER_WEB_SOCKET_CONNECTIONS[webSocketConnectionId].webSocket.send(JSON.stringify(request))

                    RG_UNSUBSCRIPTIONS_TRACKER[unsubscriptionId] = baseCurrency
                }

                for (let a = 0; a < unsubscribeSymbolsEntries.length; a++) {
                    const [baseCurrency] = unsubscribeSymbolsEntries[a]
                    const tradePair: RGTraderTradingPairs[""] = RG_TRADER_TRADING_PAIRS[baseCurrency]

                    handleTradingPairUnsubscription(tradePair.webSocketConnectionId, baseCurrency, tradePair)

                    RG_TRADER_TRADING_PAIRS[baseCurrency].unsubscriptionAckInterval = setInterval(() => {
                        const previousUnsubscriptionId: number = Number(Object.entries(RG_UNSUBSCRIPTIONS_TRACKER).filter(([_, v]) => v === baseCurrency)[0][0])
                        delete RG_UNSUBSCRIPTIONS_TRACKER[previousUnsubscriptionId]

                        handleTradingPairUnsubscription(tradePair.webSocketConnectionId, baseCurrency, tradePair)
                    }, Math.floor(1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)) * Object.entries(RG_TRADER_TRADING_PAIRS).length)

                    if (APE_IN_SYMBOLS[tradePair.symbol]) {
                        if (APE_IN_SYMBOLS[tradePair.symbol].timeoutId) {
                            clearTimeout(APE_IN_SYMBOLS[tradePair.symbol].timeoutId)
                        }
                        delete APE_IN_SYMBOLS[tradePair.symbol]
                    }

                    await sleep(Math.floor(
                        1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)
                    ))
                }
            }

            const newSubscribeSymbolsEntries: [string, RGTraderBinanceSymbols[""]][] = Object.entries(newSubscribeSymbols)
            if (newSubscribeSymbolsEntries.length > 0) {
                for (let a = 0; a < newSubscribeSymbolsEntries.length; a++) {
                    const [baseCurrency] = newSubscribeSymbolsEntries[a]
                    const tradePair: RGTraderTradingPairs[""] = RG_TRADER_TRADING_PAIRS[baseCurrency]
                    const websockets: [string, RGTraderBinanceWebSocketConnections[""]][] = Object.entries(RG_TRADER_WEB_SOCKET_CONNECTIONS)

                    if (tradePair) {
                        for (let b = 0; b < websockets.length; b++) {
                            const [webSocketConnectionId, websocket] = websockets[b]
                            if (!(websocket.numberOfActiveSubscriptions === maximumWebSocketSubscriptions)) {
                                const subscriptionId: number = new Date().getTime()
                                const request = {
                                    method: "SUBSCRIBE",
                                    params: [`${tradePair.symbol.toLowerCase()}@trade`],
                                    id: subscriptionId
                                }
                                // Subscribe
                                RG_TRADER_WEB_SOCKET_CONNECTIONS[webSocketConnectionId].webSocket.send(JSON.stringify(request))

                                RG_TRADER_TRADING_PAIRS[baseCurrency].webSocketConnectionId = webSocketConnectionId
                                RG_TRADER_WEB_SOCKET_CONNECTIONS[webSocketConnectionId].numberOfActiveSubscriptions += 1

                                delete newSubscribeSymbols[baseCurrency]

                                await sleep(Math.floor(
                                    1000 / Number(process.env.BINANCE_MAX_JSON_MESSAGES_PER_SECOND)
                                ))

                                break
                            }
                        }
                    }

                    if (newSubscribeSymbols[baseCurrency]) {
                        break
                    }
                }

                // Initiate subscriptions of unsubscribed new symbols
                const rgTradingPairsArray: [string, RGTraderTradingPairs[""]][] = Object.entries(RG_TRADER_TRADING_PAIRS).filter(([key]) => !!newSubscribeSymbols[key])
                const totalTradingPairsCount: number = rgTradingPairsArray.length
                const totalWebSocketConnectionsCount: number = Math.ceil(totalTradingPairsCount / maximumWebSocketSubscriptions)
                for (let a = 0; a < totalWebSocketConnectionsCount; a++) {
                    const rgTradingPairsForSubscription: [string, RGTraderTradingPairs[""]][] = rgTradingPairsArray.slice(
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

const openWebSocketConnection = (rgTradingPairs: [string, RGTraderTradingPairs[""]][]) => {
    const webSocketConnectionId: string = `${new Date().getTime()}.${Math.random()}`
    tryCatchFinallyUtil(() => {
        const webSocket: WebSocket = new WebSocket(`${process.env.BINANCE_WEBSOCKET_URL}/stream`)

        RG_TRADER_WEB_SOCKET_CONNECTIONS[webSocketConnectionId] = {
            webSocket,
            numberOfActiveSubscriptions: 0
        }

        const handleTradingPairSubscription = (baseCurrency: string, tradingPair: RGTraderTradingPairs[""]) => {
            const subscriptionId: number = new Date().getTime()
            const request = {
                method: "SUBSCRIBE",
                params: [`${tradingPair.symbol.toLowerCase()}@trade`],
                id: subscriptionId
            }
            // Subscribe
            webSocket.send(JSON.stringify(request))

            RG_SUBSCRIPTIONS_TRACKER[subscriptionId] = baseCurrency
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

                if (RG_TRADER_TRADING_PAIRS[baseCurrency]) {
                    handleTradingPairSubscription(baseCurrency, rgTradePair)

                    RG_TRADER_TRADING_PAIRS[baseCurrency].subscriptionAckInterval = setInterval(() => {
                        if (Object.entries(RG_SUBSCRIPTIONS_TRACKER).filter(([_, v]) => v === baseCurrency)[0]) {
                            const previousSubscriptionId: number = Number(Object.entries(RG_SUBSCRIPTIONS_TRACKER).filter(([_, v]) => v === baseCurrency)[0][0])
                            delete RG_SUBSCRIPTIONS_TRACKER[previousSubscriptionId]
                        }

                        handleTradingPairSubscription(baseCurrency, rgTradePair)
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
                if (RG_SUBSCRIPTIONS_TRACKER[response.id]) {
                    RG_TRADER_TRADING_PAIRS[RG_SUBSCRIPTIONS_TRACKER[response.id]].webSocketConnectionId = webSocketConnectionId
                    RG_TRADER_WEB_SOCKET_CONNECTIONS[webSocketConnectionId].numberOfActiveSubscriptions += 1

                    clearInterval(RG_TRADER_TRADING_PAIRS[RG_SUBSCRIPTIONS_TRACKER[response.id]].subscriptionAckInterval)
                    RG_TRADER_TRADING_PAIRS[RG_SUBSCRIPTIONS_TRACKER[response.id]].subscriptionAckInterval = undefined
                }

                if (RG_UNSUBSCRIPTIONS_TRACKER[response.id]) {
                    RG_TRADER_WEB_SOCKET_CONNECTIONS[webSocketConnectionId].numberOfActiveSubscriptions -= 1
                    clearInterval(RG_TRADER_TRADING_PAIRS[RG_UNSUBSCRIPTIONS_TRACKER[response.id]].unsubscriptionAckInterval)
                    RG_TRADER_TRADING_PAIRS[RG_UNSUBSCRIPTIONS_TRACKER[response.id]].unsubscriptionAckInterval = undefined

                    delete RG_TRADER_TRADING_PAIRS[RG_UNSUBSCRIPTIONS_TRACKER[response.id]]
                }
            }
            // Trades
            else {
                const tradingPair: RGTraderTradingPairs[""] = (Object.entries(RG_TRADER_TRADING_PAIRS).filter(([_, v]) => v.symbol === response.data.s)[0] ?? [])[1]
                if (tradingPair) {
                    const {baseCurrency, quoteCurrency} = tradingPair
                    const newNotificationBuyPrice: number = tradingPair.notificationStrikeCount === 0 ?
                        fixDecimalPlaces((1.00 + Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) * Number(response.data.p), tradingPair.quoteDecimalPlaces) :
                        fixDecimalPlaces(tradingPair.notificationBuyPrice + tradingPair.notificationStrikeUnitPrice, tradingPair.quoteDecimalPlaces)

                    if (tradingPair.notificationBuyPrice) {
                        if (newNotificationBuyPrice < tradingPair.notificationBuyPrice) {
                            RG_TRADER_TRADING_PAIRS[baseCurrency].notificationBuyPrice = newNotificationBuyPrice
                        }
                    } else {
                        RG_TRADER_TRADING_PAIRS[baseCurrency].notificationBuyPrice = newNotificationBuyPrice
                    }

                    if (Number(response.data.p) >= tradingPair.notificationBuyPrice && tradingPair.notificationBuyPrice !== 0) {
                        RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeCount += 1
                        if (RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeCount === 1) {
                            RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeUnitPrice = fixDecimalPlaces((tradingPair.notificationBuyPrice * Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) / (1.00 + Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT)), tradingPair.quoteDecimalPlaces)
                        }

                        if (RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeCount > 1) buySignalStrikeNotification(response.data.s, Number(response.data.p), RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeCount, Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT), quoteCurrency)

                        if (tradingPair.notificationStrikeTimeoutId) clearTimeout(tradingPair.notificationStrikeTimeoutId)
                        RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeTimeoutId = setTimeout(
                            () => {
                                RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeCount = 0
                                RG_TRADER_TRADING_PAIRS[baseCurrency].notificationBuyPrice = 0
                                RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeUnitPrice = 0

                                clearTimeout(RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeTimeoutId)
                                RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeTimeoutId = undefined
                            }, 1000 * 60 * Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_TIMEOUT_MINS) * RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeCount
                        ) as NodeJS.Timeout
                        RG_TRADER_TRADING_PAIRS[baseCurrency].notificationBuyPrice = RG_TRADER_TRADING_PAIRS[baseCurrency].notificationBuyPrice + RG_TRADER_TRADING_PAIRS[baseCurrency].notificationStrikeUnitPrice
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

            delete RG_TRADER_WEB_SOCKET_CONNECTIONS[webSocketConnectionId]
            if (rgTradingPairs.length > Object.entries(RG_TRADER_TRADING_PAIRS).filter(([_, v]) => v.webSocketConnectionId === webSocketConnectionId).length) {
                openWebSocketConnection(rgTradingPairs)
            } else {
                openWebSocketConnection(Object.entries(RG_TRADER_TRADING_PAIRS).filter(([_, v]) => v.webSocketConnectionId === webSocketConnectionId))
            }
        }))
    }, (e) => {
        logError(`openWebSocketConnection() - ${e}`)
        if (rgTradingPairs.length > Object.entries(RG_TRADER_TRADING_PAIRS).filter(([_, v]) => v.webSocketConnectionId === webSocketConnectionId).length) {
            openWebSocketConnection(rgTradingPairs)
        } else {
            openWebSocketConnection(Object.entries(RG_TRADER_TRADING_PAIRS).filter(([_, v]) => v.webSocketConnectionId === webSocketConnectionId))
        }
    })
}

const apeInService = () => {
    let ws = new Websocket(`${process.env.BINANCE_WEBSOCKET_URL}/ws/!ticker@arr`)

    tryCatchFinallyUtil(
        () => {
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

            ws.on('open', () => {
                heartBeat(ws)
            })

            ws.on('ping', () => {
                // tslint:disable-next-line:no-empty
                ws.pong(() => {
                })
                heartBeat(ws)
            })

            ws.on('message', (data: string) => {
                tryCatchFinallyUtil(
                    () => {
                        const Data: BinanceWebSocketTickerArrStreamResponse = JSON.parse(data)

                        for (const symbol of Data) {
                            if (APE_IN_SYMBOLS[symbol.s]) {
                                const apeInParameters = APE_IN_SYMBOLS[symbol.s]
                                const percentChange: number = Math.round(((Number(symbol.c) - Number(symbol.h)) / Number(symbol.h)) * 10000) / 100
                                if ((percentChange < apeInParameters.percentage)) {
                                    // Send notification
                                    sendApeInNotification(symbol.s, percentChange)

                                    // Set next percentage
                                    apeInParameters.percentage = apeInParameters.percentage + Number(process.env.APE_IN_INCREMENT_PERCENTAGE)
                                    if (apeInParameters.timeoutId) {
                                        clearTimeout(apeInParameters.timeoutId)
                                    }
                                    apeInParameters.timeoutId = setTimeout(() => {
                                        // Reset notification percentage
                                        apeInParameters.percentage = Number(process.env.APE_IN_START_PERCENTAGE)

                                        clearTimeout(apeInParameters.timeoutId)
                                        apeInParameters.timeoutId = undefined
                                    }, 1000 * 60 * 60 * Number(process.env.APE_IN_PERCENT_TIMEOUT_HRS))
                                }
                            }
                        }
                    },
                    (e) => {
                        ws.terminate()
                        logError(`apeInService.webSocket.message() - ${e}`)
                    })
            })

            ws.on('close', ((code, reason) => {
                clearPingTimeoutId()
                ws = undefined

                // Restart the service
                apeInService()
            }))

            ws.on('error', (error => {
                ws.terminate()
                logError(`apeInService.webSocket.error() - ${error}`)
            }))
        }, (e) => {
            ws.terminate()
            logError(`apeInService() - ${e}`)
        })
}

// Run!
const run = () => {
    startServiceNotification()

    getSymbolsData()

    RG_TRADER_GET_SYMBOLS_INTERVAL_ID = setInterval(() => {
        getSymbolsData()
    }, 1000 * 60 * Number(process.env.BINANCE_SYMBOL_UPDATE_INTERVAL_MINS)) // Every 10min update our symbols. In case of new listings.

    apeInService()
}

run()