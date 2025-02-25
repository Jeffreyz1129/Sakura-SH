import { DiscordInviteRegex, PRIORITY } from '#constants'
import type { SakuraInvite } from '@prisma/client'
import { container } from '@sapphire/pieces'
import { Invite, NewsChannel, TextChannel } from 'discord.js'
import type { CategoryChannel, DiscordAPIError, EmbedField, Guild, Interaction, Message, MessageActionRowOptions, MessageButtonOptions, MessageEmbed, MessageSelectMenuOptions, SelectMenuInteraction } from 'discord.js'

export const addCommas = (num: number) => num.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,')

export const mod = (a: number, n: number) => ((a % n) + n) % n

export const processCategory = async (category: CategoryChannel) => {
    for (const channel of category.children.values()) {
        if (!channel)
            continue
        if (!((channel instanceof NewsChannel) || (channel instanceof TextChannel)))
            continue

        const messages = await channel.messages.fetch({ limit: 8 })

        if (!messages.size)
            continue

        for (const message of messages.values())
            await processMessage(message, PRIORITY.CATEGORY)
    }

    await container.settings.updateCategory(BigInt(category.guildId), BigInt(category.id))
}

export const processCode = async (guildId: bigint, code: string, priority: PRIORITY) => {
    const result = await container.queue.add(() => {
        return container.client
            .fetchInvite(code)
            .catch((error: DiscordAPIError) => error)
    }, { priority })

    if (result instanceof Invite) {
        await container.invites.add(guildId, result)
        return result
    } else {
        await container.invites.add(guildId, code)
        return null
    }
}

export const processMessage = async (message: Message, priority: PRIORITY) => {
    const now = new Date
    const { content, guild } = message
    const guildId = BigInt(guild.id)
    const codes = [...content.matchAll(DiscordInviteRegex)].map(match => match[1])

    let bad = 0, good = 0

    if (!codes.length)
        return { bad, good }

    for (const code of codes) {
        let valid: boolean, invite: Invite | SakuraInvite

        if (container.invites.has(guildId, code)) {
            invite = container.invites.get(guildId, code)
            valid = invite.isPermanent
                || (invite.isValid && (invite.expiresAt > now))
            
        } else {
            invite = await processCode(guildId, code, priority)
            valid = (invite instanceof Invite)
                ? (invite?.expiresAt < now)
                : false
        }

        valid ? good++ : bad++
    }

    return { bad, good }
}

export const replyWithButtonPages = async <T>(message: Message, items: T[], itemsPerPage: number, itemFunction: (item: T) => EmbedField) => {
    const color = container.settings.getInfoEmbedColor(BigInt(message.guildId))
    const pages: Partial<MessageEmbed>[] = Array
        .from({ length: Math.ceil(items.length / itemsPerPage) }, (_, i) => items.slice(itemsPerPage * i, itemsPerPage * (i + 1)))
        .map((itemChunk, i, chunks) => ({
            color,
            fields: itemChunk.map(itemFunction),
            footer: { text: `Page ${ i + 1 } of ${ Math.min(chunks.length, 25) }` }
        }))

    if (pages.length === 1)
        await message.reply({ embeds: [pages[0]] })
    else {
        let currentPage = 0

        const previousButton: MessageButtonOptions = { customId: 'previous', emoji: '⬅️', style: 'PRIMARY', type: 'BUTTON' }
        const nextButton: MessageButtonOptions = { customId: 'next', emoji: '➡️', style: 'PRIMARY', type: 'BUTTON' }
        const row: MessageActionRowOptions = { components: [previousButton, nextButton], type: 'ACTION_ROW' }
        const reply = await message.reply({ components: [row], embeds: [pages[currentPage]] })
        const filter = (interaction: Interaction) => interaction.user.id === message.author.id
        const collector = reply.createMessageComponentCollector({ componentType: 'BUTTON', dispose: true, filter, time: 20000 })

        collector.on('collect', async interaction => {
            if (!interaction.isButton())
                return
            if (interaction.customId === 'previous')
                currentPage = mod(currentPage - 1, pages.length)
            if (interaction.customId === 'next')
                currentPage = mod(currentPage + 1, pages.length)
            
            await interaction.update({ components: [row], embeds: [pages[currentPage]] })
        })
        collector.on('end', async () => {
            await reply.edit({ components: [], embeds: [pages[currentPage]] })
        })
    }
}

export const replyWithInfoEmbed = async (message: Message, description: string) => {
    const guildId = BigInt(message.guildId)
    const color = container.settings.getInfoEmbedColor(guildId)
    const embed: Partial<MessageEmbed> = { color, description }

    return message.reply({ embeds: [embed] })
}

export const replyWithSelectPages = async(message: Message, embedFunction: (guild: Guild) => Partial<MessageEmbed>) => {
    const guilds = message.client.guilds.cache

    if (guilds.size === 1) {
        const embed = embedFunction(message.guild)
        await message.reply({ embeds: [embed] })
    } else {
        const guildSelectMenu: MessageSelectMenuOptions = {
            customId: 'guildSelectMenu',
            options: guilds.map(guild => ({ label: guild.name, value: guild.id })),
            placeholder: 'Select server...',
            type: 'SELECT_MENU'
        }
        const row: MessageActionRowOptions = { components: [guildSelectMenu], type: 'ACTION_ROW' }
        const counts = await message.reply({ components: [row], content: String.fromCharCode(8203) })
        const filter = (interaction: Interaction) => interaction.user.id === message.author.id
        const collector = counts.createMessageComponentCollector({ componentType: 'SELECT_MENU', dispose: true, filter, time: 20000 })

        collector.on('collect', async interaction => {
            if (!interaction.isSelectMenu())
                return
            
            const embed = embedFunction(guilds.get(interaction.values[0]))
            await interaction.update({ components: [row], embeds: [embed] })
        })
        collector.on('end', async interactions => {
            const guildId = (interactions.last() as SelectMenuInteraction)?.values[0]
            const embed = guildId
                ? embedFunction(guilds.get(guildId))
                : { color: container.settings.getInfoEmbedColor(BigInt(guildId)), description: 'No server selected' }

            await counts.edit({ components: [], embeds: [embed] })
        })
    }    
}