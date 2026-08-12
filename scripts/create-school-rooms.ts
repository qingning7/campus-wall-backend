import process from "node:process"
import { RoomType } from "../generated/prisma/client.js"
import { prisma } from "../src/lib/prisma.js"

async function main() {
    const dryRun = process.argv.includes("--dry-run")

    const schoolsWithoutRoom = await prisma.school.findMany({
        where: {
            room: null
        },
        select: {
            id: true,
            name: true
        },
        orderBy: {
            name: "asc"
        }
    })

    console.log(`缺少公共房间的学校数: ${schoolsWithoutRoom.length}`)

    if (schoolsWithoutRoom.length === 0) {
        console.log("所有学校都已经有公共房间。")
        return
    }

    if (dryRun) {
        console.log("")
        console.log("当前为 dry-run，没有写入数据库。")
        console.log("将为以下学校创建公共房间:")

        for (const school of schoolsWithoutRoom.slice(0, 20)) {
            console.log(`- ${school.name}`)
        }

        if (schoolsWithoutRoom.length > 20) {
            console.log(`...以及另外 ${schoolsWithoutRoom.length - 20} 所学校`)
        }

        return
    }

    const result = await prisma.room.createMany({
        data: schoolsWithoutRoom.map((school) => ({
            type: RoomType.SCHOOL,
            schoolId: school.id,
            name: school.name
        })),
        skipDuplicates: true
    })

    console.log(`成功创建 ${result.count} 个学校公共房间。`)
}

main()
    .catch((error: unknown) => {
        console.error("")
        console.error("创建学校公共房间失败。")
        console.error(error)
        process.exitCode = 1
    })
    .finally(async () => {
        await prisma.$disconnect()
    })