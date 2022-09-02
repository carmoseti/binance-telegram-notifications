import WebSocket from "ws"

export type BinanceSymbolsResponse = {
    timezone: string
    serverTime: number
    rateLimits: Array<{
        rateLimitType: string
        interval: string
        intervalNum: string
        limit: number
    }>
    exchangeFilters: Array<any>
    symbols: Array<{
        "symbol": string
        "status": "TRADING" | "BREAK" | ""
        "baseAsset": string
        "baseAssetPrecision": number
        "quoteAsset": string
        "quotePrecision": number
        "quoteAssetPrecision": number
        "baseCommissionPrecision": number
        "quoteCommissionPrecision": number
        "orderTypes": Array<"LIMIT" | "LIMIT_MAKER" | "MARKET" | "STOP_LOSS_LIMIT" | "TAKE_PROFIT_LIMIT">,
        "icebergAllowed": boolean
        "ocoAllowed": boolean
        "quoteOrderQtyMarketAllowed": boolean
        "allowTrailingStop": boolean
        "cancelReplaceAllowed": boolean
        "isSpotTradingAllowed": boolean
        "isMarginTradingAllowed": boolean
        "filters": Array<Record<string, any>>,
        "permissions": Array<"SPOT" | "MARGIN" | "TRD_GRP_004">
    }>
}
export type BinanceWebSocketTradeStreamResponse = {
    id?: number
    result?: null
    stream?: string
    data?: {
        e: "trade"     // Event type
        E: string   // Event time
        s: string    // Symbol
        t: number       // Trade ID
        p: string     // Price
        q: string       // Quantity
        b: number          // Buyer order ID
        a: number          // Seller order ID
        T: number   // Trade time
        m: boolean        // Is the buyer the market maker?
        M: boolean         // Ignore
    }
}
export type BinanceWebSocketTickerArrStreamResponse = Array<{
    "e": "24hrTicker",  // Event type
    "E": number     // Event time
    "s": string      // Symbol
    "p": string      // Price change
    "P": string      // Price change percent
    "w": string      // Weighted average price
    "x": string      // First trade(F)-1 price (first trade before the 24hr rolling window)
    "c": string      // Last price
    "Q": string          // Last quantity
    "b": string      // Best bid price
    "B": string          // Best bid quantity
    "a": string      // Best ask price
    "A": string         // Best ask quantity
    "o": string      // Open price
    "h": string      // High price
    "l": string      // Low price
    "v": string       // Total traded base asset volume
    "q": string          // Total traded quote asset volume
    "O": number             // Statistics open time
    "C": number      // Statistics close time
    "F": number             // First trade ID
    "L": number         // Last trade Id
    "n": number          // Total number of trades
}>

export type BinanceTelegramWebSocketConnections = {
    [id: string]: {
        webSocket: WebSocket
        numberOfActiveSubscriptions: number
    }
}

export type BinanceTelegramSymbols = {
    [baseCurrency: string]: {
        [quoteCurrency: string]: BinanceSymbolsResponse["symbols"][0]
    }
}

export type BinanceTelegramTradingPairs = Record<string, {
    webSocketConnectionId: string
    symbol: string
    baseCurrency: string
    quoteCurrency: string
    baseDecimalPlaces: number
    quoteDecimalPlaces: number
    subscriptionAckInterval: NodeJS.Timeout
    unsubscriptionAckInterval: NodeJS.Timeout
    notificationStrikeCount: number
    notificationBuyPrice: number
    notificationStrikeUnitPrice: number
    notificationStrikeTimeoutId: NodeJS.Timeout
}>