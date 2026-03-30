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

    // Feedback
    correct: "Correct",
    wrong: "Wrong",
    whatCorrectDisposal: "What was the correct disposal?",
    cancel: "Cancel",
    saving: "Saving...",
    thanksFeedback: "Thanks for the feedback",
    lowConfidenceWarning: "Low confidence — please verify or ask staff",

    // Feedback streams
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

    // Dashboard
    feedbackDashboard: "Feedback Dashboard",
    totalFeedback: "Total Feedback",
    accuracyRate: "Accuracy Rate",
    corrections: "Corrections Needed",
    mostCorrectedItems: "Most Corrected Items",
    suggestedOverrides: "Suggested Overrides",
    recentFeedback: "Recent Feedback",
    item: "Item",
    predicted: "Predicted",
    actual: "Actual",
    time: "Time",
    noFeedbackYet: "No feedback collected yet. Use the kiosk to classify items and provide feedback.",
    timesWrong: "times wrong",
    correctedTo: "corrected to",
    addOverride: "Add Override",
    backToKiosk: "Back to Kiosk",
    adaptiveThreshold: "Adaptive Threshold",
    currentThreshold: "Current threshold",
    suggestedThreshold: "Suggested",
    basedOnFeedback: "Based on feedback accuracy",

    // Review page
    imageReview: "Image Review",
    imageReviewSubtitle: "Assign correct bins to items users marked as wrong",
    pendingCount: "pending",
    correctedCount: "corrected",
    noWrongEntries: "No wrong feedback entries yet.",
    needsCorrection: "Needs correction",
    correctedSection: "Corrected",
    imageUnavailable: "Image unavailable (upload failed)",
    noImage: "No image",
    editName: "Edit name",
    saveName: "Save",
    cancelEdit: "Cancel",
    correctedName: "Corrected name",
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

    correct: "正しい",
    wrong: "間違い",
    whatCorrectDisposal: "正しい分別先は？",
    cancel: "キャンセル",
    saving: "保存中...",
    thanksFeedback: "フィードバックありがとうございます",
    lowConfidenceWarning: "確信度が低い — スタッフにご確認ください",

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

    feedbackDashboard: "フィードバック ダッシュボード",
    totalFeedback: "フィードバック合計",
    accuracyRate: "正解率",
    corrections: "修正が必要",
    mostCorrectedItems: "よく間違えるアイテム",
    suggestedOverrides: "推奨ルール追加",
    recentFeedback: "最近のフィードバック",
    item: "アイテム",
    predicted: "予測",
    actual: "実際",
    time: "時間",
    noFeedbackYet:
      "まだフィードバックがありません。キオスクでアイテムを分類してフィードバックしてください。",
    timesWrong: "回不正解",
    correctedTo: "正解は",
    addOverride: "ルール追加",
    backToKiosk: "キオスクに戻る",
    adaptiveThreshold: "適応型しきい値",
    currentThreshold: "現在のしきい値",
    suggestedThreshold: "推奨値",
    basedOnFeedback: "フィードバック精度に基づく",

    // Review page
    imageReview: "画像レビュー",
    imageReviewSubtitle: "ユーザーが「間違い」と報告したアイテムに正しいゴミ箱を割り当てる",
    pendingCount: "件 未対応",
    correctedCount: "件 修正済み",
    noWrongEntries: "まだ間違いのフィードバックはありません。",
    needsCorrection: "修正が必要",
    correctedSection: "修正済み",
    imageUnavailable: "画像が利用できません（アップロード失敗）",
    noImage: "画像なし",
    editName: "名前を編集",
    saveName: "保存",
    cancelEdit: "キャンセル",
    correctedName: "修正済み名前",
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
