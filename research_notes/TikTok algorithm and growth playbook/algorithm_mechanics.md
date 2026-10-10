# TikTok For You feed: algorithm mechanics (state as of October 2026)

Evidence tiers used throughout: **[A] official** (TikTok/ByteDance publications), **[B] leak / filing / audit** (leaked documents, court filings, journalism, peer-reviewed or preprint audits), **[C] folklore** (creator-economy blogs and unverified claims). "Secondary" marks a third-party report of a tier A or B source that I could not open directly.

Research caveats that apply to the whole file:
- TikTok's Help Center page "How TikTok recommends content" and the Transparency Center page "Introduction to the TikTok recommendation system" both returned only a title when fetched (JavaScript-rendered). Their current wording was NOT verified in this session. The only official text read in full is the June 2020 Newsroom post and the January 2026 joint venture announcement.
- The NYT and WSJ originals are paywalled; they were read through a syndicated reprint (Boston.com) and through secondary coverage (Gizmodo, Tubefilter). The NPR article on the Kentucky filing timed out; its content is taken from search-result excerpts.

## 1. What signals does TikTok say it uses, how are they weighted, and what does it say it does NOT use?

### Takeaway
Officially, three signal families (user interactions, video information, device/account settings) feed a per-user ranking in which strong interest signals such as finishing a longer video outweigh weak ones such as shared country. TikTok states that follower count and an account's prior hits are not direct factors. No official numeric weights have ever been published.

### Cited Findings
- [A, June 18 2020] User interactions are "the videos you like or share, accounts you follow, comments you post, and content you create." — [TikTok Newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [A, 2020] Video information is "details like captions, sounds, and hashtags." — [TikTok Newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [A, 2020] Device and account settings are "your language preference, country setting, and device type." — [TikTok Newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [A, 2020] Weighting, the only official statement of relative weight: "A strong indicator of interest, such as whether a user finishes watching a longer video from beginning to end, would receive greater weight than a weak indicator, such as whether the video's viewer and creator are both in the same country." — [TikTok Newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [A, 2020] What is not used directly: "neither follower count nor whether the account has had previous high-performing videos are direct factors in the recommendation system." — [TikTok Newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [A, 2020] Cold start: new users can "select categories of interest, like pets or travel"; otherwise "we start by offering you a generalized feed of popular videos." — [TikTok Newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [A, 2020] Diversification: "your For You feed generally won't show two videos in a row made with the same sound or by the same creator," and the system deliberately inserts less-relevant videos to "give you additional opportunities to stumble upon new content categories." — [TikTok Newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [A, date uncertain, see Gaps] A current Newsroom page describes the For You feed as "where TikTok recommends new content based on people's interests" and says "AI helps us build a platform dedicated to curiosity and discovering new things rather than around social connections." — [TikTok Newsroom](https://newsroom.tiktok.com/tiktoks-new-features-to-help-you-control-your-scroll)
- [Secondary, unattributed to a specific TikTok page] Industry write-ups now restate the three families as user interactions (watch time, likes, shares, comments), content information (spoken words, on-screen text, captions, hashtags) and user profile (language, region, viewing history). This expanded list was not confirmed against an official TikTok page in this session. — [Stellar Rising](https://www.stellarising.com/blog/tiktok-search-insights-toktrak)

### Inferences
- "Not a direct factor" is narrower than "irrelevant". Followers can still matter indirectly, because they supply early viewers whose behaviour the system measures (see section 4).
- The 2020 statement names completion of a *longer* video as the strong signal, which is consistent with every tier B source below that puts watch time ahead of likes and comments.

### Gaps
- Whether the 2020 wording (especially the follower-count sentence) is repeated verbatim in the 2026 Help Center and Transparency Center pages could not be verified; both pages failed to render.
- No official source gives numeric weights or a rank order among likes, shares, comments, saves and follows.

## 2. How does initial distribution work (test batches, thresholds, time windows, longevity)?

### Takeaway
I found no official TikTok statement confirming a fixed "test batch" of 200 to 500 viewers, a 70% completion threshold, or a 30 to 90 minute window; these numbers appear only in third-party blogs with no cited source. What is documented is that every candidate video is scored per viewer by predicted engagement, and that staff could manually override distribution ("heating").

### Cited Findings
- [B, NYT Dec 2021 via reprint] The leaked "TikTok Algo 101" document says the recommender scores videos with a value equation and returns the highest-scoring videos to each user; it describes per-user prediction, not a universal batch size. — [Boston.com reprint of NYT](https://www.boston.com/news/commentary/2021/12/06/how-tiktok-reads-your-mind)
- [B, Forbes Jan 2023, secondary] TikTok and ByteDance staff used "heating," a manual push that ensures specific videos "achieve a certain number of video views." An internal document said: "The total video views of heated videos accounts for a large portion of the daily total video views, around 1-2%, which can have a significant impact on overall core metrics." One improper heating incident gave an account more than three million views. — [Forbes Australia](https://www.forbes.com.au/news/innovation/tiktoks-secret-heating-button-can-make-anyone-go-viral)
- [B, ByteDance paper 2022] ByteDance's Monolith system is built for online training, because batch-training frameworks keep training and serving separate, "preventing the model from interacting with customer feedback in real-time." It uses a collisionless embedding table with expirable embeddings and frequency filtering, and the paper says it is deployed in the BytePlus Recommend product. — [arXiv 2209.07663](https://arxiv.org/pdf/2209.07663)
- [C] Blogs state that within the first 30 to 90 minutes a video goes to a test audience of 200 to 500 people mixing followers and non-followers, that 70%+ watch-through triggers wider distribution, and that early swipe-aways stall a video under 500 views. None of the pages cites a TikTok source for these figures; the attribution to individual pages below comes from a search summary and was not checked page by page. — [go-viral.app](https://www.go-viral.app/blog/tiktok-algorithm-2026/); [posteverywhere.ai](https://posteverywhere.ai/blog/how-the-tiktok-algorithm-works); [launchpointhq.com](https://www.launchpointhq.com/blog/ugc-influencer-report)

### Inferences
- A system that learns from feedback in near real time (Monolith) and ranks per viewer makes staged expansion a natural emergent behaviour: a new video has little data, gets limited exposure, and gains exposure as predictions improve. That supports the general "small audience first, then more" idea without supporting any specific batch size.
- Because heating existed, some unusually large reach is not algorithmic at all; this weakens reverse-engineered "threshold" rules built from viral outliers.

### Gaps
- No tier A or B source found for batch sizes, wave counts, percentage thresholds or time windows.
- No credible source found on how long a video stays eligible (days, weeks, months). Late "revivals" are widely reported by creators but I found no official or audited figure.
- Whether TikTok's Creator Academy currently describes staged distribution was not verified.

## 3. Which engagement signals matter most? (Algo 101, WSJ, court filings, DSA, audits)

### Takeaway
Every leak and audit points the same way: watch time (including rewatching) is the dominant signal, with likes and comments as additional predicted terms, all in service of retention and time spent. No credible source gives a ranked weighting for shares, saves or follows.

### Cited Findings
- [B, NYT Dec 5 2021 via reprint] Algo 101's simplified scoring formula: "Plike X Vlike + Pcomment X Vcomment + Eplaytime X Vplaytime + Pplay X Vplay". The document adds: "The actual equation in use is much more complicated, but the logic behind is the same." — [Boston.com reprint of NYT](https://www.boston.com/news/commentary/2021/12/06/how-tiktok-reads-your-mind)
- [B, 2021] The formula covers likes, comments, playtime and whether the video was played. Shares, saves and follows do not appear in the simplified version. — [Gizmodo](https://gizmodo.com/leaked-tiktok-doc-reveals-its-obvious-secret-to-an-addi-1848166901)
- [B, 2021] The document states the company's "ultimate goal" is adding daily active users, pursued through two metrics: "retention" (whether a user comes back) and "time spent." It lists four goals: "user value," "long-term user value," "creator value," and "platform value." — [Boston.com reprint of NYT](https://www.boston.com/news/commentary/2021/12/06/how-tiktok-reads-your-mind)
- [B, 2021] Anti-boredom terms named in the document include "same_author_seen" and "same_tag_today", plus "forced recommendation in users' for u feed and dispersion." The system also suppresses "like bait" videos that ask for likes, and "creator monetization" is listed as a goal. — [Boston.com reprint of NYT](https://www.boston.com/news/commentary/2021/12/06/how-tiktok-reads-your-mind)
- [B, 2021] A TikTok spokesperson confirmed the document's authenticity and said it was written to explain the algorithm to non-technical employees. — [Gizmodo](https://gizmodo.com/leaked-tiktok-doc-reveals-its-obvious-secret-to-an-addi-1848166901)
- [B, 2021, expert opinion] Guillaume Chaslot: "This system means that watch time is key." Julian McAuley called the approach "totally reasonable, but traditional stuff," with the edge coming from "fantastic volumes of data, highly engaged users." — [Boston.com reprint of NYT](https://www.boston.com/news/commentary/2021/12/06/how-tiktok-reads-your-mind)
- [B, WSJ July 2021, secondary] The WSJ ran over 100 bot accounts with assigned interests that lingered on or rewatched matching videos without otherwise engaging. TikTok identified their interests in under two hours and narrowed feeds into "rabbit holes"; one bot's feed became 93% depression and mental-health videos. The same coverage cites 90 to 95% of TikTok views coming from recommendations versus about 70% on YouTube. — [Tubefilter](https://tubefilter.com/2021/07/21/tiktok-recommendation-algorithm-wall-street-journal-guillaume-chaslot/)
- [B, Kentucky AG complaint, unredacted Oct 2024, via NPR excerpt] Internal TikTok research put the "habit moment" at 260 videos watched in the first week, which can take under 35 minutes because some videos are as short as 8 seconds. Internal material also showed time-management tools produced a negligible reduction in screen time. — [NPR](https://www.npr.org/2024/10/11/g-s1-27676/tiktok-redacted-documents-in-teen-safety-lawsuit-revealed)
- [B, academic audit 2025] A sock-puppet reproduction study reports that the watch action has the strongest personalisation effect on the For You page, growing as a video is watched longer or multiple times; like and follow show more exploration first and stronger exploitation later. — [arXiv 2504.18140](https://arxiv.org/abs/2504.18140)
- [B, same study] The authors (Mosnar et al., April 2025) warn that TikTok audit findings reproduce poorly and "often hold only in the short term," depending on methodology and platform state. — [arXiv 2504.18140](https://arxiv.org/abs/2504.18140)
- [B, WWW 2024] A data-donation study (347 users, 9.2 million recommendations) found that in a user's first 1,000 videos, roughly a third to half were shown as exploitation of predicted interests, with the rest exploratory. — [arXiv 2403.12410](https://arxiv.org/pdf/2403.12410); [University of Washington](https://www.washington.edu/news/2024/04/24/tiktok-black-box-algorithm-and-design-user-behavior-recommendation)
- [A] The Creator Rewards Program excludes views from people who mark a video "not interested" from qualified views, showing the signal is recorded at the view level. This is as reported by a secondary source describing TikTok's terms. — [Influencer Marketing Hub](https://influencermarketinghub.com/tiktok-creator-rewards-program/)
- [B, regulatory] The European Commission's preliminary DSA view treats infinite scroll, autoplay, push notifications and highly personalised recommendations as systemic risks, with the investigation focused on the "rabbit hole effect"; TikTok has said it will challenge the addictive-design findings. — [ComplexDiscovery](https://complexdiscovery.com/eus-preliminary-dsa-findings-put-tiktoks-engagement-design-in-the-regulatory-crosshairs/); [Crowell](https://www.crowell.com/a/web/xjuaM4g6zeeVU5v229RCpe/tiktok-to-challenge-categorically-false-dsa-addictive-design-findings.pdf)

### Inferences
- The WSJ bots produced strong personalisation using watch behaviour alone, which independently corroborates the Eplaytime term and the official "finishes a longer video" statement. Watch time is the one signal on which tiers A and B all agree.
- Popular ranked lists ("shares > saves > comments > likes", with point values) have no support in any tier A or B source found. Treat them as folklore.
- Because Eplaytime is an expected-playtime term multiplied by a value, absolute seconds watched plausibly matter alongside completion percentage; the leak does not specify which.

### Gaps
- No reliable source found for the relative weight of shares, saves/favorites, or follows-from-video.
- I did not retrieve TikTok's DSA risk-assessment reports or the TikTok v. Garland filings themselves; no mechanics-level detail from them is included.
- The WSJ's more detailed figures were not verified against the original.
- Algo 101 is from 2021; no later leak confirms the formula is unchanged.

## 4. Follower vs. non-follower distribution; Following and Friends feeds

### Takeaway
The For You feed is built for discovery among strangers, and TikTok says follower count is not a direct ranking factor. I found no official or audited figure for what share of a video's first viewers are followers.

### Cited Findings
- [A, 2020] Follower count is not a direct factor in the recommendation system; accounts you follow are a user-interaction signal for your own feed. — [TikTok Newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [A] TikTok describes the platform as built "around curiosity and discovering new things rather than around social connections." — [TikTok Newsroom](https://newsroom.tiktok.com/tiktoks-new-features-to-help-you-control-your-scroll)
- [B, 2021, secondary] 90 to 95% of TikTok views come from recommended content. — [Tubefilter](https://tubefilter.com/2021/07/21/tiktok-recommendation-algorithm-wall-street-journal-guillaume-chaslot/)
- [B, 2025 audit] Following an account shifts the follower's feed, initially with more exploration and later with strong exploitation. — [arXiv 2504.18140](https://arxiv.org/abs/2504.18140)
- [C] Blogs claim the initial test audience is "a mix of your existing followers and non-followers"; no source is given. — [go-viral.app](https://www.go-viral.app/blog/tiktok-algorithm-2026/)

### Inferences
- Followers matter mainly as an audience whose follow is a per-viewer interest signal, not as an account-level multiplier.

### Gaps
- No verified official description of how the Following and Friends feeds are ranked was retrieved.
- No data on the follower share of early impressions.

## 5. Search and TikTok SEO

### Takeaway
TikTok has built official search tooling (Creator Search Insights, editable auto-assigned keywords, "search value" in creator payouts), which confirms search is a real distribution surface. I found no official statement of how search results are ranked, or of how much captions, on-screen text or speech each contribute.

### Cited Findings
- [A, via trade press] Creator Search Insights shows frequently searched topics, can be filtered by category or "For You", and flags "content gap" topics that are highly searched but have few videos. — [Search Engine Land](https://searchengineland.com/?p=438398)
- [A, via trade press] TikTok lets creators add and remove keywords assigned to a video; its in-app notice reads: "This post displays keywords automatically added by TikTok based on popular searches. You can manage them at any time." — [Social Media Today](https://www.socialmediatoday.com/news/tiktok-lets-users-add-relevant-keywords-to-metadata/818507/)
- [A, secondary] TikTok says the Creator Rewards formula considers video performance and play duration, search value, audience engagement, viewer location and advertising value. — [Influencer Marketing Hub](https://influencermarketinghub.com/tiktok-creator-rewards-program/)
- [A, 2020] Captions, sounds and hashtags are officially named as video information used for recommendations. — [TikTok Newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [C/secondary] The claim that spoken words (speech recognition) and on-screen text are ranking inputs is widely repeated but was only found in third-party articles. — [Stellar Rising](https://www.stellarising.com/blog/tiktok-search-insights-toktrak)

### Inferences
- The "keywords automatically added by TikTok" notice shows TikTok runs its own content classification and maps videos to search queries without creator input, so creator-written keywords supplement rather than replace it.
- Paying for "search value" gives creators a direct incentive to target searched topics, independent of any ranking boost.

### Gaps
- No official ranking explanation for TikTok search retrieved.
- No evidence found, in any tier, quantifying the effect of hashtags (including #fyp) on reach.

## 6. Topic classification and niche consistency

### Takeaway
ByteDance's published engineering describes embedding-based, continuously trained recommendation, and audits show feeds narrow quickly around inferred interests. I found no tier A or B evidence that an *account-level* niche score exists or that posting consistently in one niche is rewarded.

### Cited Findings
- [B, ByteDance 2022] Monolith uses large collisionless embedding tables for sparse ID features with real-time online training. — [arXiv 2209.07663](https://arxiv.org/pdf/2209.07663)
- [B, 2021] Algo 101 references per-video tags and author identity in its repetition controls ("same_tag_today", "same_author_seen"), indicating videos carry topic tags used in ranking. — [Boston.com reprint of NYT](https://www.boston.com/news/commentary/2021/12/06/how-tiktok-reads-your-mind)
- [A, June 2025] "Manage Topics" lets users adjust how often more than 10 topic categories (for example Creative Arts, Travel, Nature, Sports) are recommended, confirming an official topic taxonomy applied to videos. — [TikTok Newsroom](https://newsroom.tiktok.com/personalize-for-you-feed-with-new-features?lang=en-MY)
- [A, secondary] For the Creator Rewards "Additional Reward", TikTok asks for a focus on a specific area of expertise. — [Influencer Marketing Hub](https://influencermarketinghub.com/tiktok-creator-rewards-program/)
- [B, 2021, secondary] WSJ bots were sorted into narrow interest clusters in under two hours. — [Tubefilter](https://tubefilter.com/2021/07/21/tiktok-recommendation-algorithm-wall-street-journal-guillaume-chaslot/)

### Inferences
- Classification is evidenced at the video and viewer level. The official statement that prior high-performing videos are not a direct factor argues against a strong account-level "niche authority" score.
- Niche consistency may still help indirectly: followers gained from one topic are likelier to watch the next video on that topic, improving early watch-time data. This is reasoning, not a sourced finding.

### Gaps
- No source found describing TikTok's content-understanding models (vision, speech, text) in production.
- No controlled evidence on niche consistency versus mixed content.

## 7. Video length, the Creator Rewards Program, and watch time

### Takeaway
TikTok has pushed longer video since 2023 to 2024 through monetisation: the Creator Rewards Program only pays on original videos of one minute or more. TikTok-supplied statistics favour longer videos on total watch time, but they are self-reported and partly circular.

### Cited Findings
- [A, secondary] Creator Rewards eligibility: 18+ (19 in South Korea), at least 10,000 followers and 100,000 video views in the last 30 days; videos must be original, at least one minute long, and not a Duet, Stitch or Photo Mode post. — [Backstage](https://www.backstage.com/magazine/article/how-to-join-tiktoks-creator-rewards-program-79061/); official page (not rendered in this session): [TikTok Support](https://support.tiktok.com/en/business-and-creator/creator-rewards-program/creator-rewards-program)
- [A, secondary] A qualified view is a unique view from the For You feed lasting more than five seconds; fraudulent, paid, promoted and artificial views and views from people who marked "not interested" are excluded, and a video needs at least 1,000 For You views. — [Influencer Marketing Hub](https://influencermarketinghub.com/tiktok-creator-rewards-program/); [Metricool](https://metricool.com/tiktok-creator-fund/)
- [A, secondary] Additional Reward criteria: 1080p or higher, clear visuals, polished editing, specialised focus. — [Influencer Marketing Hub](https://influencermarketinghub.com/tiktok-creator-rewards-program/)
- [A, 2024, secondary] TikTok said users spend half their time on the app watching videos longer than one minute. Sources disagree on when this was said: one dates it January 2024, another June 2024. — [YPulse](https://www.ypulse.com/newsfeed/2024/01/03/tiktok-revealed-that-users-now-spend-half-their-time-on-the-app-watching-videos-longer-than-60-seconds/); [Shopify](https://www.shopify.com/blog/how-long-can-a-tiktok-be)
- [A, 2023 to 2024, secondary] TikTok said creators posting videos over one minute gained five times more followers than those posting shorter videos over a six-month period. — [eMarketer](https://www.emarketer.com/content/longer-tiktoks-perform-better-new-opportunities-advertisers)
- [Secondary, 2024 third-party data] Videos over one minute got 63.8% more watch time than 30 to 60 second videos, 175.6% more than 10 to 30 second videos and 264.5% more than 5 to 10 second videos. — [Social Media Today](https://www.socialmediatoday.com/news/research-tiktok-longer-videos-get-more-reach/)
- [A, Creator Academy, secondary] High-quality content creators are said to get 72% more watch time per video view and more than 40 times greater follower growth. The exact Creator Academy page was not verified; the figure surfaced in a search summary alongside the Hootsuite guide. — [Hootsuite](https://blog.hootsuite.com/tiktok-algorithm/)
- [Secondary] As of June 2024 videos can be three seconds to 10 minutes; trials of 20, 30 and 60 minute uploads were reported in March 2024. — [Shopify](https://www.shopify.com/blog/how-long-can-a-tiktok-be)

### Inferences
- "Longer videos get more watch time" is close to tautological for total seconds; it does not show that a longer video earns more *impressions*. The leak's Eplaytime term suggests absolute watch time is rewarded, so a well-retained 60 to 90 second video can out-score a fully watched 10 second one, but a poorly retained long video would not.
- The 5-second qualified-view rule is a payment rule, not a ranking rule; the popular "3-second rule" for ranking has no official source.

### Gaps
- No official statement found that length itself is a ranking input.
- Creator Rewards details are relayed by secondary sources; official wording and current thresholds should be rechecked on TikTok's own page.

## 8. Recent changes, 2024 to 2026

### Takeaway
The largest structural change is the January 2026 US joint venture, which now retrains and updates the US recommendation algorithm on US user data inside Oracle's cloud. Product-side changes add user controls (Manage Topics, Smart Keyword Filters) rather than new disclosed ranking rules.

### Cited Findings
- [A, Jan 23 2026] "The Joint Venture will retrain, test, and update the content recommendation algorithm on U.S. user data," with the algorithm secured in Oracle's US cloud. — [TikTok Newsroom](https://newsroom.tiktok.com/announcement-from-the-new-tiktok-usds-joint-venture-llc?lang=en)
- [A, 2026] The joint venture has "decision-making authority for trust and safety policies" for the US content ecosystem. — [TikTok Newsroom](https://newsroom.tiktok.com/announcement-from-the-new-tiktok-usds-joint-venture-llc?lang=en)
- [A, 2026] "Interoperability enables the Joint Venture to provide U.S. users with a global TikTok experience, ensuring U.S. creators can be discovered and businesses can operate on a global scale." — [TikTok Newsroom](https://newsroom.tiktok.com/announcement-from-the-new-tiktok-usds-joint-venture-llc?lang=en)
- [A, 2026] Ownership: Silver Lake, Oracle and MGX 15% each; ByteDance 19.9%; remainder with other investors. CEO Adam Presser; seven-member, majority-American board. — [TikTok Newsroom](https://newsroom.tiktok.com/announcement-from-the-new-tiktok-usds-joint-venture-llc?lang=en)
- [B] The deal closed January 22, 2026; the algorithm is licensed from ByteDance and retrained, and members of Congress have questioned whether ByteDance's continuing role in the algorithm satisfies the divestiture law. — [NPR](https://www.npr.org/2026/01/22/nx-s1-5685456/tiktok-finalizes-deal-to-form-new-american-entity); [ABC7](https://abc7news.com/post/oracle-will-manage-tiktoks-algorithm-us-users-trump-administration-deal/17866333/)
- [A, June 2025] Manage Topics adjusts how often 10+ topics are recommended; the settings "won't eliminate any topics entirely." — [TikTok Newsroom](https://newsroom.tiktok.com/personalize-for-you-feed-with-new-features?lang=en-MY)
- [A, June 2025] Smart Keyword Filters use AI to add synonyms and related terms automatically (filtering "remodeling" also filters "renovation"); the keyword limit was to rise from 100 to 200. — [TechCrunch](https://techcrunch.com/2025/06/03/tiktok-rolls-out-ai-powered-smart-keyword-filters-to-limit-content-you-dont-want-to-see)
- [A, date uncertain] TikTok describes "a new feature that lets people choose how much AI-generated content they want to see." — [TikTok Newsroom](https://newsroom.tiktok.com/tiktoks-new-features-to-help-you-control-your-scroll)
- [A, 2023, secondary] A dedicated STEM feed was announced in 2023 for US launch, sitting alongside Following and For You, with content reviewed by Common Sense Networks (appropriateness) and Poynter (accuracy). — [Search Engine Journal](https://www.searchenginejournal.com/tiktok-stem-feed/482258/)
- [A, via trade press] Editable video keywords and Creator Search Insights (section 5) are also recent additions. — [Social Media Today](https://www.socialmediatoday.com/news/tiktok-lets-users-add-relevant-keywords-to-metadata/818507/)

### Inferences
- A US model retrained on US-only data could behave differently from the global model, so pre-2026 audits and non-US creator data may transfer less well to US accounts. No measured before/after comparison was found; third-party commentary on this is speculative.

### Gaps
- No credible measurement of how US reach or ranking changed after January 2026.
- The fetch of the June 2025 "control your scroll" Newsroom URL returned text the summariser dated October 1, 2026 and that concerned AI-generated content controls. Either the page was updated or a different post was served; the date and content of that item are unverified.
- The "refresh your For You feed" reset feature was not sourced in this session (my recollection is a 2023 launch; unverified).
- No official "how recommendations work" revision dated 2024 to 2026 could be read.

## 9. Which widely repeated claims are folklore or debunked?

### Takeaway
Most creator "rules" have no official or audited support, and one (follower count or past hits drive reach) is directly contradicted by TikTok. Reduced distribution is real, but it is tied to eligibility rules rather than an undisclosed "shadowban" switch.

### Cited Findings
- [A vs C] "Big accounts or accounts with past hits get automatic reach": contradicted. Follower count and previous high-performing videos are not direct factors. — [TikTok Newsroom](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- [C] "200 to 500 view test pool", "70% completion to pass", "first 30 to 90 minutes decide everything": unsourced numbers in third-party blogs (see section 2). — [go-viral.app](https://www.go-viral.app/blog/tiktok-algorithm-2026/)
- [A, secondary] For You ineligibility is documented for unoriginal content copied with minimal input, low-quality content (split screens, meaningless reactions), profiles carrying contact information for advertising, and content with no meaningful value made to attract followers or clicks. This is the documented mechanism behind much of what creators call a "shadowban". — [Hootsuite](https://blog.hootsuite.com/tiktok-algorithm/)
- [C/secondary] TikTok has never confirmed a "shadowban" feature; third-party guides say reduced distribution follows guideline flags, "unoriginal" labels or weak retention. These guides also assert, citing TikTok documentation without links, that there is no documented penalty for posting daily, for business accounts (which differ in music-library access), or for scheduling through the official API. — [SocialKit](https://socialk.it/en/blog/tiktok-shadowban-guide); [ViralWatch](https://viralwatch.app/viralwatch-video-analysis-blog/what-is-a-tiktok-shadowban/)
- [B] "Asking for likes boosts a video": the leaked document says like-bait is identified and suppressed. — [Boston.com reprint of NYT](https://www.boston.com/news/commentary/2021/12/06/how-tiktok-reads-your-mind)
- [B] "Virality is purely algorithmic": contradicted by heating, which accounted for around 1 to 2% of daily views per an internal document. — [Forbes Australia](https://www.forbes.com.au/news/innovation/tiktoks-secret-heating-button-can-make-anyone-go-viral)
- [B] Reverse-engineered rules age quickly: audit findings "often hold only in the short term." — [arXiv 2504.18140](https://arxiv.org/abs/2504.18140)

### Inferences
- Posting-time rules, "deleting videos hurts the account", "#fyp boosts reach" and the "first-hour rule" are best classed as unverified: I found neither confirmation nor an explicit official denial for any of them. Per-viewer ranking on predicted watch behaviour gives no obvious mechanism for #fyp or deletion effects, and posting time could only matter through who is online to supply early data.
- The official ineligibility list means "my reach dropped" often has a documented cause (originality or quality classification) that creators can check before assuming a hidden penalty.

### Gaps
- No direct official TikTok statement located on posting time, deleting videos, account-type reach, or #fyp.
- The debunking sources for business accounts and posting frequency are low-authority blogs that do not link to the TikTok documentation they cite.
