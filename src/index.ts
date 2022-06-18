import Websocket from "ws"
import {tryCatchFinallyUtil} from "./utils/error"
import {logError} from "./utils/log"
import {fixDecimalPlaces} from "./utils/number"
import {buySignalStrikeNotification, startServiceNotification} from "./utils/telegram"
import {config} from "dotenv"
import {sendApeInEmail} from "./utils/email"

// Load .env properties
config()

const SUPPORTED_QUOTE_ASSETS: string[] = String(process.env.BINANCE_QUOTE_ASSETS).split(",")
const getBaseAssetName = (tradingPair: string) => {
    let baseAssetName: string = tradingPair

    // tslint:disable-next-line:prefer-for-of
    for (let i = 0; i < SUPPORTED_QUOTE_ASSETS.length; i++) {
        if (tradingPair.startsWith(SUPPORTED_QUOTE_ASSETS[i])) {
            return SUPPORTED_QUOTE_ASSETS[i]
        }
    }

    SUPPORTED_QUOTE_ASSETS.forEach((quoteAsset: string) => {
        baseAssetName = baseAssetName.replace(quoteAsset, '')
    })
    return baseAssetName
}
const getQuoteAssetName = (tradingPair: string) => {
    return tradingPair.replace(getBaseAssetName(tradingPair), '')
}
const hasSupportedQuoteAsset = (tradingPair: string): boolean => {
    return SUPPORTED_QUOTE_ASSETS.reduce((previousValue, currentValue) => {
        return previousValue || (tradingPair.search(currentValue) !== -1 && tradingPair.endsWith(currentValue))
    }, false)
}

const WEBSOCKET_SYMBOL_CONNECTIONS: { [symbol: string]: Websocket } = {}
const runIndividualSymbolTickerStream = (symbol: string,
                                         previous ?: {
                                             notificationBuyPrice: number
                                             notificationStrikeCount: number
                                             notificationStrikeTimeoutId: NodeJS.Timeout
                                             notificationStrikeUnitPrice: number
                                             errorRetryCount: number
                                         }) => {
    let errorRetryCount: number = previous ? previous.errorRetryCount : 0
    if (errorRetryCount > Number(process.env.BINANCE_WEBSOCKET_ERROR_MAX_RETRY_COUNT)) {
        return false
    }

    const ws = new Websocket(`${process.env.BINANCE_WEBSOCKET_URL}/ws/${symbol.toLowerCase()}@trade`)
    WEBSOCKET_SYMBOL_CONNECTIONS[symbol] = ws

    let notificationBuyPrice: number = previous ? previous.notificationBuyPrice : 0
    let notificationStrikeCount: number = previous ? previous.notificationStrikeCount : 0
    let notificationStrikeTimeoutId: NodeJS.Timeout = previous ? previous.notificationStrikeTimeoutId : undefined
    let notificationStrikeUnitPrice: number = previous ? previous.notificationStrikeUnitPrice : 0

    const quoteAsset: string = getQuoteAssetName(symbol)

    tryCatchFinallyUtil(
        () => {
            let pingTimeoutId: NodeJS.Timeout
            const clearPingTimeoutId = () => {
                if (pingTimeoutId) {
                    clearTimeout(pingTimeoutId)
                    pingTimeoutId = undefined
                }
            }
            const heartBeat = (websocket: Websocket) => {
                clearPingTimeoutId()
                pingTimeoutId = setTimeout(() => {
                    websocket.terminate()
                }, Number(process.env.BINANCE_WEBSOCKET_PING_TIME_MS) + 30000) as NodeJS.Timeout
            }

            ws.on('open', () => {
                errorRetryCount = 0
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
                        const Data = JSON.parse(data)

                        // Notifications
                        const newNotificationBuyPrice: number = notificationStrikeCount === 0 ?
                            fixDecimalPlaces((1.00 + Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) * Number(Data.p), 12) :
                            fixDecimalPlaces(notificationBuyPrice + notificationStrikeUnitPrice, 12)

                        if (notificationBuyPrice) {
                            if (newNotificationBuyPrice < notificationBuyPrice) {
                                notificationBuyPrice = newNotificationBuyPrice
                            }
                        } else {
                            notificationBuyPrice = newNotificationBuyPrice
                        }

                        if (Number(Data.p) >= notificationBuyPrice && notificationBuyPrice !== 0) {
                            notificationStrikeCount += 1
                            if (notificationStrikeCount === 1) {
                                notificationStrikeUnitPrice = fixDecimalPlaces((notificationBuyPrice * Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT)) / (1.00 + Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT)), 12)
                            }

                            if (notificationStrikeCount > 1) buySignalStrikeNotification(symbol, Number(Data.p), notificationStrikeCount, Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_UNIT_PERCENT), quoteAsset)

                            if (notificationStrikeTimeoutId) clearTimeout(notificationStrikeTimeoutId)
                            notificationStrikeTimeoutId = setTimeout(
                                () => {
                                    notificationStrikeCount = 0
                                    notificationBuyPrice = 0
                                    notificationStrikeUnitPrice = 0

                                    clearTimeout(notificationStrikeTimeoutId)
                                    notificationStrikeTimeoutId = undefined
                                }, 1000 * 60 * Number(process.env.BINANCE_NOTIFICATIONS_STRIKE_TIMEOUT_MINS) * notificationStrikeCount
                            ) as NodeJS.Timeout
                            notificationBuyPrice = notificationBuyPrice + notificationStrikeUnitPrice
                        }
                    },
                    (e) => {
                        ws.terminate()
                        logError(`runIndividualSymbolTickerStream() error : ${e}`)
                    }
                )
            })

            ws.on('close', ((code, reason) => {
                clearPingTimeoutId()

                if (WEBSOCKET_SYMBOL_CONNECTIONS[symbol]) {
                    delete WEBSOCKET_SYMBOL_CONNECTIONS[symbol]

                    if (code === 1006) { // ws.terminate()
                        runIndividualSymbolTickerStream(symbol, {
                            notificationBuyPrice,
                            notificationStrikeCount,
                            notificationStrikeTimeoutId,
                            notificationStrikeUnitPrice,
                            errorRetryCount
                        })
                    }
                    if (code === 1005) { // ws.close()
                        runIndividualSymbolTickerStream(symbol)
                    }
                    // tslint:disable-next-line:no-empty
                } else {
                }

            }))

            ws.on('error', (error => {
                errorRetryCount++
                ws.terminate()
                logError(`runIndividualSymbolTickerStream() web socket error : ${error}`)
            }))
        },
        (e) => {
            errorRetryCount++
            ws.terminate()
            logError(`runIndividualSymbolTickerStream() error : ${e}`)
        }
    )
}

const SYMBOLS: { [symbol: string]: string } = {}
const initializeSymbols = () => {
    const ws = new Websocket(`${process.env.BINANCE_WEBSOCKET_URL}/ws/!ticker@arr`)

    const timeout: NodeJS.Timeout = setTimeout(() => {
        let symbolKeys: string[] = Object.keys(SYMBOLS)
        // tslint:disable-next-line:prefer-for-of
        for (let a = 0; a < symbolKeys.length; a++) {
            const baseAssetName: string = getBaseAssetName(symbolKeys[a])
            for (let i = 0; i < SUPPORTED_QUOTE_ASSETS.length; i++) {
                const tradingPair: string = `${baseAssetName}${SUPPORTED_QUOTE_ASSETS[i]}`
                if (SYMBOLS.hasOwnProperty(tradingPair)) {
                    const discardQuoteAssets: string[] = SUPPORTED_QUOTE_ASSETS.slice(i + 1)
                    discardQuoteAssets.forEach((value) => {
                        delete SYMBOLS[`${baseAssetName}${value}`]

                        if (WEBSOCKET_SYMBOL_CONNECTIONS[`${baseAssetName}${value}`]) {
                            let websocket: Websocket = WEBSOCKET_SYMBOL_CONNECTIONS[`${baseAssetName}${value}`]
                            delete WEBSOCKET_SYMBOL_CONNECTIONS[`${baseAssetName}${value}`]
                            websocket.close()
                            websocket = undefined
                        }

                        if (APE_IN_SYMBOLS[`${baseAssetName}${value}`]) {
                            if (APE_IN_SYMBOLS[`${baseAssetName}${value}`].timeoutId) {
                                clearTimeout(APE_IN_SYMBOLS[`${baseAssetName}${value}`].timeoutId)
                            }
                            delete APE_IN_SYMBOLS[`${baseAssetName}${value}`]
                        }
                    })
                }
            }
            symbolKeys = Object.keys(SYMBOLS)
        }

        // Pickup new pairs and initiate services..
        symbolKeys.forEach((symbol) => {
            if (!WEBSOCKET_SYMBOL_CONNECTIONS[symbol]) {
                runIndividualSymbolTickerStream(symbol)
                APE_IN_SYMBOLS[symbol] = {
                    percentage: Number(process.env.APE_IN_START_PERCENTAGE),
                    timeoutId: undefined
                }
            }
        })

        ws.close()
    }, 1000 * 60) as NodeJS.Timeout

    tryCatchFinallyUtil(
        () => {
            let pingTimeoutId: NodeJS.Timeout
            const clearPingTimeoutId = () => {
                if (pingTimeoutId) {
                    clearTimeout(pingTimeoutId)
                    pingTimeoutId = undefined
                }
            }
            const heartBeat = (websocket: Websocket) => {
                clearPingTimeoutId()
                pingTimeoutId = setTimeout(() => {
                    websocket.terminate()
                }, Number(process.env.BINANCE_WEBSOCKET_PING_TIME_MS) + 30000) as NodeJS.Timeout
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
                        const Data = JSON.parse(data)

                        for (const symbol of Data) {
                            if (!SYMBOLS[symbol.s] &&
                                (hasSupportedQuoteAsset(symbol.s))
                            ) {
                                SYMBOLS[symbol.s] = symbol.s
                            }
                        }
                    },
                    (e) => {
                        ws.terminate()
                        logError(`initializeSymbols() web socket onMessage() error : ${e}`)
                    }
                )
            })

            ws.on('error', (error => {
                ws.terminate()
                logError(`initializeSymbols() web socket onError() : ${error}`)
            }))

            ws.on('close', ((code, reason) => {
                clearPingTimeoutId()
                clearTimeout(timeout)
                if (code === 1006) { // ws.terminate()
                    initializeSymbols()
                }
            }))
        },
        (e) => {
            ws.terminate()
            logError(`initializeSymbols() error : ${e}`)
        }
    )
}

const APE_IN_SYMBOLS: {
    [symbol: string]: {
        percentage: number
        timeoutId: NodeJS.Timeout
    }
} = {}
const apeInEmailService = () => {
    const ws = new Websocket(`${process.env.BINANCE_WEBSOCKET_URL}/ws/!ticker@arr`)

    tryCatchFinallyUtil(
        () => {
            let pingTimeoutId: NodeJS.Timeout
            const clearPingTimeoutId = () => {
                if (pingTimeoutId) {
                    clearTimeout(pingTimeoutId)
                    pingTimeoutId = undefined
                }
            }
            const heartBeat = (websocket: Websocket) => {
                clearPingTimeoutId()
                pingTimeoutId = setTimeout(() => {
                    websocket.terminate()
                }, Number(process.env.BINANCE_WEBSOCKET_PING_TIME_MS) + 30000) as NodeJS.Timeout
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
                        const Data = JSON.parse(data)

                        for (const symbol of Data) {
                            if (APE_IN_SYMBOLS[symbol.s]) {
                                const apeInParameters = APE_IN_SYMBOLS[symbol.s]
                                if (Number(symbol.P) < apeInParameters.percentage) {
                                    // Send email notification
                                    sendApeInEmail(symbol.s, Number(symbol.P))

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
                        logError(`apeInEmailService() error : ${e}`)
                    })
            })

            ws.on('close', ((code, reason) => {
                clearPingTimeoutId()

                if (code === 1006) { // ws.terminate()
                    apeInEmailService()
                }
            }))

            ws.on('error', (error => {
                ws.terminate()
                logError(`apeInEmailService() web socket error : ${error}`)
            }))
        }, (e) => {
            ws.terminate()
            logError(`apeInEmailService() error : ${e}`)
        })
}

// ----------PROD------------------
startServiceNotification()

initializeSymbols()
setInterval(() => {
    initializeSymbols()
}, 1000 * 60 * Number(process.env.BINANCE_SYMBOL_UPDATE_INTERVAL_MINS)) // Every 10min update our symbols. Incase of new listings.

setInterval(() => {
    Object.keys(WEBSOCKET_SYMBOL_CONNECTIONS).forEach((symbol) => {
        WEBSOCKET_SYMBOL_CONNECTIONS[symbol].terminate()
    })
}, 1000 * 60 * 60 * Number(process.env.BINANCE_WEBSOCKET_FORCE_TERMINATE_HRS)) // Every 24hrs force terminate all websocket connections

apeInEmailService()