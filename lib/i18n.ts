export type Locale = "en" | "ja";

const translations = {
  en: {
    // Kiosk display
    analyzing: "Analyzing...",
    live: "Live",
    holdSteady: "Hold the item steady...",

    // LiveOverlay - empty state
    readingItem: "Reading item...",
    holdSteadyCam: "Hold the item steady in front of the camera",
    holdItemUp: "Hold an item up",
    systemWillIdentify: "The system will identify it",

    // LiveOverlay - error
    retryingAutomatically: "Retrying automatically",
    connectionSlow: "Connection slow — retrying...",
    classificationFailed: "Classification failed — retrying...",

    // Result panel
    detectedItem: "Detected Item",
    disposeIn: "Dispose in",
    putThisIn: "Put this in",
    uncertain: "Uncertain",
    needsVerification: "Needs Verification",
    reviewDescription:
      "The system is not confident enough to recommend a bin. Please check the signage near the bins or ask facilities staff.",
    bestGuess: "Best guess:",
    likelyBelongsIn: "This looks like it goes in",
    whenInDoubtUse: "When in doubt, use",
    notSureCheck: "Not sure? Check the label or ask staff",
    multiplePartsTitle: "This item has multiple parts",
    category: "Category",
    confidence: "Confidence",
    reasoning: "Why?",
    confidenceHigh: "High",
    confidenceMedium: "Medium",
    confidenceLow: "Low",
    confidenceHighDesc: "The system is very confident",
    confidenceMediumDesc: "Probably the right bin",
    confidenceLowDesc: "Please verify with staff",
    note: "Note",
    showOneItem: "Show one item at a time",
    multipleItemsDetected: "Multiple items detected",
    itemNumber: "Item {n}",
    cancel: "Cancel",

    // Streams
    recycling: "Recycling",
    compost: "Compost",
    landfill: "Landfill",
    special: "Special",
    ewaste: "E-Waste",
    burnable: "Burnable",
    nonBurnable: "Non-burnable",
    recyclable: "Recyclable",
    plastic: "Plastic",

    // Pipeline states
    itemDetected: "Item detected",
    holdForScan: "Hold steady for identification",
    identifyingItem: "Identifying item...",
    poorVisibility: "Try showing more of the item",
    preparingCamera: "Preparing camera...",

    // Language toggle
    langLabel: "EN",
    switchLang: "日本語",

    // Admin
    accuracyRate: "Accuracy Rate",
    item: "Item",
    predicted: "Predicted",
    time: "Time",
    backToKiosk: "Back to Kiosk",

    // Review page
    imageReview: "Image Review",
    imageReviewSubtitle: "Review all classifications and mark each as correct, wrong, or false detection",
    imageUnavailable: "Image unavailable (upload failed)",
    noImage: "No image",

    // Idle screen
    todaysStats: "Today's Stats",
    itemsSorted: "items sorted",
    successRateLabel: "success rate",
    firstUserWelcome: "You're the first user today!",
    sortingTip: "Sorting Tip",

    // Camera screen
    holdSteadyDetecting: "Item detected — Hold steady...",
    analyzingPleaseWait: "Analyzing...",

    // Result screen
    putThisInBin: "Put this in the",
    nothingDetectedTitle: "Nothing Detected",
    nothingDetectedDesc: "The system could not identify an item. Please remove the object and try again.",

    // Full review page
    fullReview: "Full Review",
    fullReviewSubtitle: "Review all classifications and mark each as correct, wrong, or false detection",
    reviewed: "reviewed",
    falseDetection: "Nothing / False",
    markCorrect: "Correct",
    markWrong: "Wrong",
    exportData: "Export ZIP",
    allEntries: "All Entries",
    pendingReview: "Pending Review",
    verdictCorrect: "Verified correct",
    verdictWrong: "Verified wrong",
    verdictFalse: "False detection",
    deleteEntry: "Delete",
    confirmDelete: "Delete this entry?",

    // Voice guidance
    voiceOn: "Sound On",
    voiceOff: "Sound Off",
    voiceResultAnnouncement: "Put {item} in {bin}",
    voicePreAction: "First: {action}",
    voiceNeedsReview: "Not sure about this item. Please check with staff.",
    voiceItemDetected: "Item detected. Hold steady.",

    // Bin positions
    binPositionFarLeft: "Far Left",
    binPositionLeft: "Left",
    binPositionCenter: "Center",
    binPositionRight: "Right",
    binPositionFarRight: "Far Right",
    binPositionArrowFarLeft: "\u2190\u2190",
    binPositionArrowLeft: "\u2190",
    binPositionArrowCenter: "\u25CF",
    binPositionArrowRight: "\u2192",
    binPositionArrowFarRight: "\u2192\u2192",

    // Compound item separation (split-screen)
    separateInto: "Separate into:",
    separationStep: "Step {n}",
    ifPresent: "if attached",

    // Stream icons (used alongside color + text for triple encoding)
    streamIconRecycling: "♻️",
    streamIconCompost: "🍂",
    streamIconLandfill: "🗑️",
    streamIconSpecial: "⚠️",
    streamIconEwaste: "🔌",
    streamIconNeedsReview: "❓",
    streamIconBurnable: "🔥",
    streamIconNonBurnable: "🧊",
    streamIconRecyclable: "♻️",
    streamIconPlastic: "🫙",
  },
  ja: {
    analyzing: "分析中...",
    live: "ライブ",
    holdSteady: "アイテムを動かさないでください...",

    readingItem: "読み取り中...",
    holdSteadyCam: "カメラの前でアイテムを動かさないでください",
    holdItemUp: "アイテムをかざしてください",
    systemWillIdentify: "自動で識別します",

    retryingAutomatically: "自動で再試行中",
    connectionSlow: "接続が遅いため再試行中...",
    classificationFailed: "分類に失敗しました。再試行中...",

    detectedItem: "検出されたアイテム",
    disposeIn: "捨てる場所",
    putThisIn: "こちらに捨ててください：",
    uncertain: "不明",
    needsVerification: "確認が必要",
    reviewDescription:
      "分類の確信度が低いため、ゴミ箱の表示を確認するか、スタッフにお尋ねください。",
    bestGuess: "推定:",
    likelyBelongsIn: "おそらくこちら：",
    whenInDoubtUse: "迷ったらこちらへ：",
    notSureCheck: "不明な場合はラベルを確認するかスタッフにお尋ねください",
    multiplePartsTitle: "このアイテムは複数の部品があります",
    category: "カテゴリ",
    confidence: "確信度",
    reasoning: "なぜ？",
    confidenceHigh: "高",
    confidenceMedium: "中",
    confidenceLow: "低",
    confidenceHighDesc: "確信度が高い",
    confidenceMediumDesc: "おそらく正しい",
    confidenceLowDesc: "スタッフに確認を",
    note: "備考",
    showOneItem: "アイテムを1つずつ見せてください",
    multipleItemsDetected: "複数のアイテムを検出しました",
    itemNumber: "アイテム {n}",
    cancel: "キャンセル",

    recycling: "リサイクル",
    compost: "コンポスト",
    landfill: "ゴミ",
    special: "特別処理",
    ewaste: "電子ゴミ",
    burnable: "可燃ゴミ",
    nonBurnable: "不燃ゴミ",
    recyclable: "資源ゴミ",
    plastic: "プラスチック",

    // Pipeline states
    itemDetected: "アイテムを検出しました",
    holdForScan: "識別のため動かさないでください",
    identifyingItem: "アイテムを識別中...",
    poorVisibility: "アイテムをもっと見せてください",
    preparingCamera: "カメラを準備中...",

    langLabel: "日本語",
    switchLang: "English",

    accuracyRate: "正解率",
    item: "アイテム",
    predicted: "予測",
    time: "時間",
    backToKiosk: "キオスクに戻る",

    // Review page
    imageReview: "画像レビュー",
    imageReviewSubtitle: "全ての分類結果を確認し、正解・不正解・誤検出を判定します",
    imageUnavailable: "画像が利用できません（アップロード失敗）",
    noImage: "画像なし",

    // Idle screen
    todaysStats: "今日の統計",
    itemsSorted: "件が分類済み",
    successRateLabel: "成功率",
    firstUserWelcome: "あなたは今日最初のユーザーです！",
    sortingTip: "分別のヒント",

    // Camera screen
    holdSteadyDetecting: "アイテムを検出 — 動かさないでください...",
    analyzingPleaseWait: "分析中...",

    // Result screen
    putThisInBin: "こちらへ捨ててください：",
    nothingDetectedTitle: "検出できませんでした",
    nothingDetectedDesc: "アイテムを識別できませんでした。アイテムを取り除いてもう一度お試しください。",

    // Full review page
    fullReview: "全件レビュー",
    fullReviewSubtitle: "全ての分類結果を確認し、正解・不正解・誤検出を判定します",
    reviewed: "件 レビュー済み",
    falseDetection: "誤検出",
    markCorrect: "正解",
    markWrong: "不正解",
    exportData: "ZIP出力",
    allEntries: "全エントリー",
    pendingReview: "レビュー待ち",
    verdictCorrect: "正解と確認済み",
    verdictWrong: "不正解と確認済み",
    verdictFalse: "誤検出と確認済み",
    deleteEntry: "削除",
    confirmDelete: "このエントリーを削除しますか？",

    // Voice guidance
    voiceOn: "音声オン",
    voiceOff: "音声オフ",
    voiceResultAnnouncement: "{item}は{bin}に捨ててください",
    voicePreAction: "まず：{action}",
    voiceNeedsReview: "この品目は不明です。スタッフに確認してください。",
    voiceItemDetected: "アイテムを検出しました。動かさないでください。",

    // Bin positions
    binPositionFarLeft: "\u5DE6\u7AEF",
    binPositionLeft: "\u5DE6",
    binPositionCenter: "\u4E2D\u592E",
    binPositionRight: "\u53F3",
    binPositionFarRight: "\u53F3\u7AEF",
    binPositionArrowFarLeft: "\u2190\u2190",
    binPositionArrowLeft: "\u2190",
    binPositionArrowCenter: "\u25CF",
    binPositionArrowRight: "\u2192",
    binPositionArrowFarRight: "\u2192\u2192",

    // Compound item separation (split-screen)
    separateInto: "分解してください：",
    separationStep: "手順 {n}",
    ifPresent: "ついている場合",

    // Stream icons
    streamIconRecycling: "♻️",
    streamIconCompost: "🍂",
    streamIconLandfill: "🗑️",
    streamIconSpecial: "⚠️",
    streamIconEwaste: "🔌",
    streamIconNeedsReview: "❓",
    streamIconBurnable: "🔥",
    streamIconNonBurnable: "🧊",
    streamIconRecyclable: "♻️",
    streamIconPlastic: "🫙",
  },
} as const;

export type TranslationKey = keyof (typeof translations)["en"];

export function t(locale: Locale, key: TranslationKey): string {
  return translations[locale][key] ?? translations.en[key] ?? key;
}

export function getLocales(): { id: Locale; label: string }[] {
  return [
    { id: "en", label: "English" },
    { id: "ja", label: "日本語" },
  ];
}
