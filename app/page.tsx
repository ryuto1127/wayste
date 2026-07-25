import Image from "next/image";

export default function Page() {
  return (
    <main className="font-sans bg-white text-neutral-900 scroll-smooth">
      {/* Section 1: Hero / Hook */}
      <section className="relative min-h-[100vh] flex flex-col justify-center px-6 md:px-12 py-20 bg-gradient-to-b from-neutral-50 to-white">
        <div className="max-w-6xl mx-auto w-full">
          <div className="text-center mb-16">
            <p className="text-sm font-semibold tracking-widest text-emerald-600 mb-6">
              wayste
            </p>
            <p className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-full text-sm font-medium mb-8">
              <span
                aria-hidden
                className="w-2 h-2 rounded-full bg-emerald-500"
              />
              動くデモ完成済み — 導入・協業パートナー募集中
            </p>
            <h1
              className="text-4xl md:text-6xl font-bold leading-tight mb-8 text-neutral-900"
              style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
            >
              <span className="inline-block">ゴミ箱に近づくだけで、</span>
              <span className="inline-block">
                <span className="text-emerald-600">正しい捨て先</span>がわかる。
              </span>
            </h1>
            <p
              className="text-lg md:text-xl text-neutral-600 mb-10 leading-relaxed"
              style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
            >
              <span className="inline-block">毎日、ゴミ箱の前で</span>
              <span className="inline-block">迷っていませんか？</span>
              <br />
              <span className="inline-block">AIが判断する。</span>
              <span className="inline-block">あなたは普段通りに捨てるだけ。</span>
            </p>
            <a
              href="#cta"
              className="inline-flex items-center gap-2 px-8 py-4 bg-neutral-900 text-white rounded-full font-medium hover:bg-emerald-600 transition-colors"
            >
              導入・協業のご相談
              <span aria-hidden>→</span>
            </a>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 max-w-5xl mx-auto">
            {[
              "/marketing/hook-1.png",
              "/marketing/hook-2.png",
              "/marketing/hook-3.png",
            ].map((src, i) => (
              <div
                key={src}
                className="aspect-[3/2] relative rounded-2xl overflow-hidden bg-neutral-100"
              >
                <Image
                  src={src}
                  alt=""
                  fill
                  className="object-cover"
                  priority={i === 0}
                  sizes="(min-width: 768px) 33vw, 100vw"
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 2: Problem */}
      <section className="py-24 md:py-32 px-6 md:px-12 bg-white">
        <div className="max-w-4xl mx-auto">
          <p className="text-sm font-semibold tracking-widest text-neutral-500 uppercase mb-4 text-center">
            こんなこと、ありませんか？
          </p>
          <h2
            className="text-3xl md:text-5xl font-bold text-center mb-16 text-neutral-900"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">ゴミ分別、</span>
            <span className="inline-block">3つの困りごと</span>
          </h2>
          <div className="space-y-6">
            {[
              "正しい分別先がわからず「なんとなく」で捨ててしまう",
              "複合アイテム（分解するか?まとめて捨てるか?)の難易度が高い",
              "国・地域・施設ごとにルールが異なり、対応しきれない",
            ].map((text, i) => (
              <div
                key={i}
                className="flex items-start gap-5 p-6 bg-neutral-50 rounded-2xl"
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 text-red-600 flex items-center justify-center text-xl font-bold">
                  ✕
                </div>
                <p
                  className="text-lg md:text-xl font-medium text-neutral-800 leading-relaxed pt-1"
                  style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
                >
                  {text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 3: What is wayste */}
      <section className="py-24 md:py-32 px-6 md:px-12 bg-neutral-50">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div className="relative aspect-[3/2] rounded-3xl overflow-hidden bg-white shadow-sm">
              <Image
                src="/marketing/usecase-office.png"
                alt="wayste 設置イメージ"
                fill
                className="object-cover"
                sizes="(min-width: 768px) 50vw, 100vw"
              />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-widest text-emerald-600 mb-4">
                wayste とは
              </p>
              <h2
                className="text-3xl md:text-4xl font-bold leading-snug mb-6 text-neutral-900"
                style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
              >
                <span className="inline-block">ゴミ箱に近づくだけで、</span>
                <span className="inline-block">正しい捨て先を教えてくれる、</span>
                <span className="inline-block">
                  <span className="text-emerald-600">AI分別キオスク</span>。
                </span>
              </h2>
              <p
                className="text-lg text-neutral-600 leading-relaxed"
                style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
              >
                <span className="inline-block">ゴミ箱の上に取り付けたカメラと画面が、</span>
                <span className="inline-block">AIで瞬時に判定。</span>
                <span className="inline-block">利用者は普段通りに捨てるだけで、</span>
                <span className="inline-block">正しい分別ができます。</span>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Section 4: Vision */}
      <section className="py-24 md:py-40 px-6 md:px-12 bg-emerald-600 text-white">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-sm font-semibold tracking-widest text-emerald-100 uppercase mb-8">
            わたしたちのビジョン
          </p>
          <h2
            className="text-3xl md:text-5xl font-bold leading-relaxed"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">余計な手間を一切かけず、</span>
            <br />
            <span className="inline-block">普段通りのプロセスで、</span>
            <br />
            <span className="inline-block">正しくゴミを捨てられる社会へ。</span>
          </h2>
        </div>
      </section>

      {/* Section 5: Tech 1 - Material discrimination */}
      <section className="py-24 md:py-32 px-6 md:px-12 bg-white">
        <div className="max-w-6xl mx-auto">
          <p className="text-sm font-semibold tracking-widest text-emerald-600 uppercase mb-4 text-center">
            技術 01
          </p>
          <h2
            className="text-3xl md:text-5xl font-bold text-center mb-6 text-neutral-900"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">形が似ていても、</span>
            <span className="inline-block">材質を見分ける。</span>
          </h2>
          <p
            className="text-lg text-neutral-600 text-center mb-16 max-w-2xl mx-auto"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">アルミ缶もペットボトルも、</span>
            <span className="inline-block">AIが材質レベルで判別。</span>
            <span className="inline-block">同じ「リサイクル」でも、</span>
            <span className="inline-block">アイテムに合わせて捨て方を案内します。</span>
          </p>
          <p className="text-sm text-neutral-500 text-center mb-8">
            このページの映像はすべて、実際に動作しているデモ画面の録画です。
          </p>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-neutral-100 aspect-[2880/1554]">
              <video
                src="/marketing/demo-can.mov"
                autoPlay
                muted
                loop
                playsInline
                className="w-full h-full object-contain"
              />
            </div>
            <div className="bg-neutral-100 aspect-[2880/1554]">
              <video
                src="/marketing/demo-bottle.mov"
                autoPlay
                muted
                loop
                playsInline
                className="w-full h-full object-contain"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Section 6: Tech 2 - Transparent */}
      <section className="py-24 md:py-32 px-6 md:px-12 bg-neutral-900 text-white">
        <div className="max-w-6xl mx-auto">
          <p className="text-sm font-semibold tracking-widest text-emerald-400 uppercase mb-4 text-center">
            技術 02
          </p>
          <h2
            className="text-3xl md:text-5xl font-bold text-center mb-6"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">透明・反射する素材も、</span>
            <span className="inline-block">しっかり判別。</span>
          </h2>
          <p
            className="text-lg text-neutral-300 text-center mb-16 max-w-2xl mx-auto"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">背景が透けて見える透明物体は、</span>
            <span className="inline-block">通常のAIには難しい課題。</span>
            <span className="inline-block">waysteは素材の特徴を抽出して</span>
            <span className="inline-block">見分けます。</span>
          </p>
          <div className="max-w-3xl mx-auto bg-neutral-800 aspect-[2880/1554]">
            <video
              src="/marketing/demo-bag.mov"
              autoPlay
              muted
              loop
              playsInline
              className="w-full h-full object-contain"
            />
          </div>
        </div>
      </section>

      {/* Section 7: Tech 3 - Multi-item */}
      <section className="py-24 md:py-32 px-6 md:px-12 bg-white">
        <div className="max-w-6xl mx-auto">
          <p className="text-sm font-semibold tracking-widest text-emerald-600 uppercase mb-4 text-center">
            技術 03
          </p>
          <h2
            className="text-3xl md:text-5xl font-bold text-center mb-6 text-neutral-900"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">複数のアイテムも、</span>
            <span className="inline-block">同時に。</span>
          </h2>
          <p
            className="text-lg text-neutral-600 text-center mb-16 max-w-2xl mx-auto"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">複数のアイテムを一度にかざしても、</span>
            <span className="inline-block">それぞれの正解を同時に表示。</span>
            <span className="inline-block">待ち時間ゼロの体験を実現します。</span>
          </p>
          <div className="max-w-3xl mx-auto bg-neutral-100 aspect-[2880/1554]">
            <video
              src="/marketing/demo-multi.mov"
              autoPlay
              muted
              loop
              playsInline
              className="w-full h-full object-contain"
            />
          </div>
        </div>
      </section>

      {/* Section 8: Privacy + Ease */}
      <section className="py-24 md:py-32 px-6 md:px-12 bg-neutral-50">
        <div className="max-w-5xl mx-auto">
          <h2
            className="text-3xl md:text-4xl font-bold text-center mb-16 text-neutral-900"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">安心・</span>
            <span className="inline-block">シンプルな設計</span>
          </h2>
          <div className="grid md:grid-cols-2 gap-8">
            <div className="p-10 bg-white rounded-3xl">
              <div className="w-14 h-14 rounded-2xl bg-emerald-100 text-emerald-600 flex items-center justify-center mb-6">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                  className="w-7 h-7"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
                  />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-3 text-neutral-900">
                顔は映らない
              </h3>
              <p className="text-neutral-600 leading-relaxed">
                カメラは下向きに固定され、映るのは手とゴミだけ。
                判定はすべて端末の中で完結し、判定のために画像が外部のAIへ送られることはありません。わからない品物は推測せず「確認が必要」と案内します。
              </p>
            </div>
            <div className="p-10 bg-white rounded-3xl">
              <div className="w-14 h-14 rounded-2xl bg-emerald-100 text-emerald-600 flex items-center justify-center mb-6">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                  className="w-7 h-7"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"
                  />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-3 text-neutral-900">
                設置はシンプル
              </h3>
              <p className="text-neutral-600 leading-relaxed">
                必要なのは下向きカメラと画面だけ。
                既存のゴミ箱の上に取り付けるだけで、すぐに導入できます。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Section 9: Use Cases */}
      <section className="py-24 md:py-32 px-6 md:px-12 bg-white">
        <div className="max-w-6xl mx-auto">
          <h2
            className="text-3xl md:text-5xl font-bold text-center mb-6 text-neutral-900"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">あらゆる空間に、</span>
            <span className="inline-block">wayste</span>
          </h2>
          <p
            className="text-lg text-neutral-600 text-center mb-16 max-w-2xl mx-auto"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">オフィスから、大学、空港、</span>
            <span className="inline-block">公共空間まで。</span>
            <span className="inline-block">場所ごとの分別ルールに合わせて</span>
            <span className="inline-block">柔軟に設定できます。</span>
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
            {[
              { src: "/marketing/usecase-office.png", label: "オフィス" },
              { src: "/marketing/usecase-university.png", label: "大学" },
              { src: "/marketing/usecase-airport.png", label: "空港" },
              { src: "/marketing/usecase-public.png", label: "公共空間" },
            ].map((u) => (
              <div key={u.label} className="group">
                <div className="relative aspect-[3/2] rounded-2xl overflow-hidden bg-neutral-100 mb-3">
                  <Image
                    src={u.src}
                    alt={u.label}
                    fill
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                    sizes="(min-width: 768px) 25vw, (min-width: 640px) 50vw, 100vw"
                  />
                </div>
                <p className="text-center text-sm md:text-base font-medium text-neutral-700">
                  {u.label}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 10: Status / Partnership */}
      <section className="py-24 md:py-32 px-6 md:px-12 bg-neutral-50">
        <div className="max-w-5xl mx-auto">
          <p className="text-sm font-semibold tracking-widest text-emerald-600 mb-4 text-center">
            開発状況
          </p>
          <h2
            className="text-3xl md:text-5xl font-bold text-center mb-6 text-neutral-900"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">アイデアではなく、</span>
            <span className="inline-block">動くシステムがあります。</span>
          </h2>
          <p
            className="text-lg text-neutral-600 text-center mb-16 max-w-2xl mx-auto"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">waysteのデモは完成済み。</span>
            <span className="inline-block">あとは、実際の現場で</span>
            <span className="inline-block">一緒に試してくれる</span>
            <span className="inline-block">パートナーを探しています。</span>
          </p>
          <div className="grid sm:grid-cols-2 gap-6">
            {[
              {
                title: "ブラウザだけで動く",
                body: "特別なサーバーは不要。PC1台とカメラ、画面があればその場で動きます。",
              },
              {
                title: "映像は端末の外に出ない",
                body: "AIの判定はすべて端末の中で完結。映像を外部に送らないため、設置場所のプライバシー懸念が構造的にありません。",
              },
              {
                title: "分別ルールは設定だけで変更",
                body: "オフィス・空港・自治体など、場所ごとに違うルールへプログラム変更なしで対応できます。",
              },
              {
                title: "協業を前提にした設計",
                body: "共同パイロット、技術提供、ライセンスなど、柔軟な形でご一緒できます。",
              },
            ].map((c) => (
              <div key={c.title} className="p-8 bg-white rounded-3xl">
                <h3 className="text-lg font-bold mb-2 text-neutral-900">
                  {c.title}
                </h3>
                <p className="text-neutral-600 leading-relaxed">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 11: CTA */}
      <section
        id="cta"
        className="py-24 md:py-40 px-6 md:px-12 bg-gradient-to-b from-white to-neutral-50"
      >
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-sm font-semibold tracking-widest text-emerald-600 mb-6">
            wayste
          </p>
          <h2
            className="text-3xl md:text-5xl font-bold mb-6 text-neutral-900"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">パイロット導入・協業の</span>
            <br />
            <span className="inline-block">パートナーを募集中です</span>
          </h2>
          <p
            className="text-lg text-neutral-600 mb-12 leading-relaxed"
            style={{ wordBreak: "keep-all", overflowWrap: "break-word" }}
          >
            <span className="inline-block">オフィス・大学・公共施設での実証実験のほか、</span>
            <span className="inline-block">共同事業化・技術提供のご相談も歓迎します。</span>
            <span className="inline-block">お気軽にご連絡ください。</span>
          </p>
          <a
            href="mailto:ryuto.2007.11.27@gmail.com?subject=wayste%20導入・協業のご相談"
            className="inline-flex items-center gap-3 px-8 py-5 bg-emerald-600 text-white rounded-full font-medium hover:bg-emerald-700 transition-colors text-lg"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"
              />
            </svg>
            ryuto.2007.11.27@gmail.com
          </a>
          <p className="text-sm text-neutral-500 mt-8">
            Pilot deployments now open.
          </p>
        </div>
        <div className="max-w-3xl mx-auto text-center mt-20 pt-10 border-t border-neutral-200">
          <p className="text-sm text-neutral-400">
            © 2026 wayste
          </p>
        </div>
      </section>
    </main>
  );
}
