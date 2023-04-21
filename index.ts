import { join } from "node:path";
import CryptoJS from "crypto-js";
import { readFile, writeFile } from "fs/promises";
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
    GatewayIntentBits,
    Interaction,
    Message,
    REST,
    Routes,
    SlashCommandBuilder,
} from "discord.js";

const { SHA256 } = CryptoJS;

interface ChatCompletion {
    object: string;
    model: string;
    choices: {
        delta: {
            content: string;
        };
        index: number;
        finish_reason: number | null;
    }[];
}

const chatCommand = new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Have a chat with ChatGPT")
    .addStringOption((option) =>
        option.setName("message").setDescription("...").setRequired(true)
    )
    .toJSON();
const reelLinkCommand = new SlashCommandBuilder()
    .setName("reellink")
    .setDescription(
        "Get a download link for an Instagram Reel. Type '!reellink [shortcode]' to receive the link."
    )
    .addStringOption((option) =>
        option
            .setName("shortcode")
            .setDescription(
                "Unique IDs for accessing and sharing. Use with Discord bot command by typing [command] [shortcode]."
            )
            .setRequired(true)
    )
    .toJSON();

(async () => {
    const replaceInFile = async (
        filePath: string,
        searchValue: string,
        replaceValue: string
    ): Promise<void> => {
        const fileContents = await readFile(filePath, "utf-8");
        const updatedData = fileContents.replace(searchValue, replaceValue);
        await writeFile(filePath, updatedData);
    };
    const openaiStreamsLibDirPath = join(
        "node_modules",
        "openai-streams",
        "dist",
        "lib"
    );
    if (typeof Bun === "undefined") {
        (await import("dotenv")).config();
    }

    const getEnvVariable = (variableName: string) => {
        const env = typeof Bun === "undefined" ? process.env : Bun.env;
        const variableValue = env[variableName];
        if (variableValue) {
            return variableValue;
        } else {
            throw new Error(`Environment variable ${variableName} not found.`);
        }
    };
    await replaceInFile(
        join(openaiStreamsLibDirPath, "openai", "edge.js"),
        "api.openai.com/",
        `${getEnvVariable("BASE_URL")}/`
    );
    const streamsFilePath = join(
        openaiStreamsLibDirPath,
        "streaming",
        "streams.js"
    );
    await replaceInFile(streamsFilePath, "){const r", "){let r");
    await replaceInFile(
        streamsFilePath,
        "}p",
        `};r = r.replace('data: [DONE]', 'data: {"object":"chat.completion.done","model":"gpt-3.5-turbo-0301","choices":[{"delta":{"content":"[DONE]"},"index":0,"finish_reason":0}]}\\n\\ndata: [DONE]');p`
    );
    const { OpenAI } = await import("openai-streams");

    const TOKEN = getEnvVariable("TOKEN");

    const rest = new REST({ version: "10" }).setToken(TOKEN);

    try {
        console.log("Started refreshing application (/) commands.");

        await rest.put(
            Routes.applicationCommands(getEnvVariable("CLIENT_ID")),
            {
                body: [chatCommand, reelLinkCommand],
            }
        );

        console.log("Successfully reloaded application (/) commands.");
    } catch (error) {
        console.error(error);
    }

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.on("ready", () => {
        console.log(`Logged in as ${client.user?.tag}!`);
    });

    client.on("interactionCreate", async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === "chat") {
            await interaction.deferReply();
            const controller = new AbortController();
            const stream = await OpenAI(
                "chat",
                {
                    model: "gpt-3.5-turbo",
                    messages: [
                        {
                            role: "user",
                            content: String(
                                interaction.options.get("message")?.value
                            ),
                        },
                    ],
                    stream: true,
                },
                {
                    apiKey: getEnvVariable("OPENAI_API_KEY"),
                    mode: "raw",
                    controller,
                }
            );
            let appendedText = "";
            const update = async () => {
                if (appendedText.length > 2000) {
                    appendedText = appendedText.slice(2000);
                    msg = await interaction.followUp(appendedText);
                }
                if (msg) await msg.edit(appendedText);
                else await interaction.editReply(appendedText);
            };
            const updateReplyInterval = setInterval(update, 1000);
            let msg: Message<boolean>;
            for await (const chunk of stream) {
                const parsedChunk: ChatCompletion = JSON.parse(
                    new TextDecoder().decode(chunk)
                );
                const firstChoice = parsedChunk.choices[0];
                if (firstChoice.finish_reason === 0) {
                    clearInterval(updateReplyInterval);
                    update();
                    break;
                }
                appendedText += firstChoice.delta.content;
            }
        } else if (interaction.commandName === "reellink") {
            await interaction.deferReply();

            const shortcode = interaction.options.get("shortcode");
            const stringified_shortcode = shortcode?.value as string;
            const shortcode_match = stringified_shortcode.match(
                /https:\/\/www\.instagram\.com\/reels?\/(?<shortcode>.+?)\/(?:\?igshid=YmMyMTA2M2Y=)?/
            );

            const response = await fetch(
                `https://www.instagram.com/reels/${shortcode_match?.groups
                    ?.shortcode!}/`,
                {
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/114.0",
                        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                        "Accept-Language": "id,en-US;q=0.7,en;q=0.3",
                        "Accept-Encoding": "gzip, deflate, br",
                        "Alt-Used": "www.instagram.com",
                        Connection: "keep-alive",
                        Cookie: getEnvVariable('COOKIE'),
                        "Upgrade-Insecure-Requests": "1",
                        "Sec-Fetch-Dest": "document",
                        "Sec-Fetch-Mode": "navigate",
                        "Sec-Fetch-Site": "none",
                        "Sec-Fetch-User": "?1",
                    },
                }
            );
            const responseText = await response.text();
            const cachedStreamMatch = responseText.match(
                />(?<streamCache>.+?RelayPrefetchedStreamCache.+?)</
            );
            console.log(cachedStreamMatch);
            const cachedStreamData: ParsedCachedStream = JSON.parse(
                cachedStreamMatch?.groups?.streamCache!
            );
            const hasMediaID = responseText.includes("media_id");
            const mediaIDString = String(hasMediaID);
            const actionRowBuilder = new ActionRowBuilder<ButtonBuilder>();
            const firstVideoVersion = (
                (cachedStreamData.require[0][3]![0] as PurpleRequire).__bbox
                    ?.require[0][3][1] as FluffyRequire
            ).__bbox.result.data.xdt_api__v1__clips__home__connection.edges[0]
                .node.media.video_versions;

            const videoButtonBuilders = actionRowBuilder.addComponents(
                firstVideoVersion
                    .filter(
                        (currentVideoVersion, index, self) =>
                            index ===
                            self.findIndex(
                                (v) => v.url === currentVideoVersion.url
                            )
                    )
                    .map((currentVideoVersion) => {
                        const buttonBuilder = new ButtonBuilder();
                        const hashedUrl = SHA256(currentVideoVersion.url);
                        const hashedUrlString = hashedUrl.toString();
                        const videoUrlCustomId = buttonBuilder.setCustomId(
                            String(currentVideoVersion.type!)
                        );
                        const videoButtonBuilder = videoUrlCustomId.setLabel(
                            `${currentVideoVersion.width}x${currentVideoVersion.height}`
                        );
                        const videoPrimaryButtonBuilder =
                            videoButtonBuilder.setStyle(ButtonStyle.Primary);
                        return videoPrimaryButtonBuilder;
                    })
            );
            const updatedMessage = await interaction.editReply({
                content: "Here are the available video versions:",
                components: [videoButtonBuilders],
            });
            const collectorFilter = (i: Interaction) =>
                i.user.id === interaction.user.id;
            while (true) {
                try {
                    const confirmation =
                        await updatedMessage.awaitMessageComponent({
                            filter: collectorFilter,
                            time: 60000,
                        });
                    actionRowBuilder.components.find(
                        (buttonBuilder) => buttonBuilder.data.label
                    );
                    const matchingVersion = firstVideoVersion.find(
                        (videoVersion) =>
                            String(videoVersion.type) === confirmation.customId
                    );
                    await confirmation.update({
                        content: `${matchingVersion?.width}x${matchingVersion?.height}`,
                        files: [
                            {
                                attachment: matchingVersion?.url!,
                            },
                        ],
                    });
                } catch (e) {
                    await interaction.editReply({
                        content:
                            "Confirmation not received within 1 minute, cancelling",
                        components: [],
                    });
                }
            }

            writeFile("index.html", responseText);
        }
    });

    client.login(TOKEN);
})();

export interface ParsedCachedStream {
    require: Array<Array<PurpleRequire[] | null | string>>;
}

export interface PurpleRequire {
    __bbox: PurpleBbox | null;
}

export interface PurpleBbox {
    require: Array<Array<Array<FluffyRequire | string> | string>>;
}

export interface FluffyRequire {
    __bbox: FluffyBbox;
}

export interface FluffyBbox {
    complete: boolean;
    result: Result;
    sequence_number: number;
}

export interface Result {
    data: Data;
    extensions: Extensions;
}

export interface Data {
    xdt_api__v1__clips__home__connection: XdtAPIV1ClipsHomeConnection;
}

export interface XdtAPIV1ClipsHomeConnection {
    edges: Edge[];
    page_info: PageInfo;
}

export interface Edge {
    node: Node;
    cursor: string;
}

export interface Node {
    media: Media;
    __typename: string;
}

export interface Media {
    pk: string;
    code: string;
    actor_fbid: null;
    has_viewer_saved: null;
    comments_disabled: null;
    like_count: number;
    has_liked: boolean;
    group: null;
    product_type: string;
    view_count: null;
    like_and_view_counts_disabled: boolean;
    user: User;
    media_type: number;
    commenting_disabled_for_viewer: null;
    clips_metadata: ClipsMetadata;
    organic_tracking_token: string;
    comment_count: number;
    creative_config: CreativeConfig | null;
    usertags: null;
    has_audio: boolean;
    is_dash_eligible: number;
    number_of_qualities: number;
    video_dash_manifest: string;
    caption: Caption | null;
    location: null;
    id: string;
    image_versions2: ImageVersions2;
    taken_at: number;
    media_overlay_info: null;
    original_height: number;
    original_width: number;
    video_versions: VideoVersion[];
    can_viewer_reshare: boolean;
}

export interface Caption {
    text: string;
}

export interface ClipsMetadata {
    music_info: MusicInfo | null;
    original_sound_info: OriginalSoundInfo | null;
}

export interface MusicInfo {
    music_asset_info: MusicAssetInfo;
    music_consumption_info: MusicConsumptionInfo;
}

export interface MusicAssetInfo {
    audio_cluster_id: string;
    cover_artwork_thumbnail_uri: string;
    title: string;
    display_artist: string;
    is_explicit: boolean;
}

export interface MusicConsumptionInfo {
    is_trending_in_clips: boolean;
    should_mute_audio: boolean;
}

export interface OriginalSoundInfo {
    audio_asset_id: string;
    ig_artist: IgArtist;
    original_audio_title: string;
    is_explicit: boolean;
    consumption_info: ConsumptionInfo;
}

export interface ConsumptionInfo {
    is_trending_in_clips: boolean;
    should_mute_audio_reason_type: null;
}

export interface IgArtist {
    profile_pic_url: string;
    id: null;
    username: string;
}

export interface CreativeConfig {
    effect_configs: EffectConfig[];
}

export interface EffectConfig {
    id: string;
    name: string;
}

export interface ImageVersions2 {
    candidates: VideoVersion[];
}

export interface VideoVersion {
    url: string;
    height: number;
    width: number;
    type?: number;
}

export interface User {
    pk: string;
    username: string;
    id: null;
    profile_pic_url: string;
    friendship_status: FriendshipStatus;
    __typename: string;
    supervision_info: null;
    is_private: boolean;
    is_embeds_disabled: null;
    is_unpublished: boolean;
}

export interface FriendshipStatus {
    following: boolean;
    blocking: null;
    is_feed_favorite: boolean;
    is_muting_reel: null;
    muting: null;
    outgoing_request: boolean;
    followed_by: null;
    incoming_request: null;
    is_restricted: boolean;
    is_bestie: boolean;
}

export interface PageInfo {
    end_cursor: string;
    has_next_page: boolean;
    has_previous_page: boolean;
    start_cursor: null;
}

export interface Extensions {
    is_final: boolean;
}
