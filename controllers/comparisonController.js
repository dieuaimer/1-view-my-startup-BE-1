import { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { serializeBigInt } from "../utils/serializeBigInt.js";
import transformBigInt from "../utils/transformBigInt.js";

const prisma = new PrismaClient();

//반복되는 쿼리를 줄리이기 위함
//함수 내부에서 빅인트처리의 로직도 함께 호출한다.
const fetchCompanies = async (query) => {
  const companies = await prisma.company.findMany(query);
  return companies.map(serializeBigInt);
};

export async function getComparison(req, res) {
  const { comparisonIds } = req.body;
  const { sortBy = "revenue", order = "asc" } = req.query;
  let orderByQuery = {};
  switch (sortBy) {
    case "revenue":
      if (order === "asc") {
        orderByQuery = { revenue: "asc" };
      } else {
        orderByQuery = { revenue: "desc" };
      }
      break;
    case "totalEmployees":
      if (order === "asc") {
        orderByQuery = { totalEmployees: "asc" };
      } else {
        orderByQuery = { totalEmployees: "desc" };
      }
      break;
    case "actualInvestment":
      if (order === "asc") {
        orderByQuery = { actualInvestment: "asc" };
      } else {
        orderByQuery = { actualInvestment: "desc" };
      }
      break;
    default:
      orderByQuery = { revenue: "asc" };
  }

  const dataQuery = {
    orderBy: orderByQuery,
    where: {
      id: {
        in: comparisonIds,
      },
    },
    select: {
      id: true,
      name: true,
      description: true,
      actualInvestment: true,
      revenue: true,
      totalEmployees: true,
      categories: { select: { name: true } },
    },
  };
  const data = await fetchCompanies(dataQuery);
  if (data) {
    const resData = data.map((item) => ({
      ...item,
      categories: item.categories.map((category) => category.name),
    }));
    res.send(resData);
  } else {
    res.status(404).send({ message: "기업정보를 찾을수 없습니다." });
  }
}

export async function getCompaniesRank(req, res) {
  const { id } = req.params;
  //기본값
  const { sortBy = "revenue", order = "ASC" } = req.query;
  //그냥 템플릿을 사용하면 프리즈마에서 sql로 인식을 못함 prisma.sql로 변환
  const orderByRank = Prisma.sql([sortBy]);
  const orderbyView = Prisma.sql([order]);
  try {
    const data = await prisma.$queryRaw`
    WITH RankedCompanies AS (
      SELECT
      *,
      ROW_NUMBER() OVER (ORDER BY ${orderByRank} desc) AS rank
      FROM "public"."Company"
    ),
    TargetRank AS (
      SELECT rank
      FROM RankedCompanies
      WHERE id = ${id}
    ),
    RackRange AS (
       SELECT rank
       FROM TargetRank
    )
    SELECT * FROM (
      SELECT * FROM RankedCompanies
      WHERE rank BETWEEN (SELECT rank - 2 FROM RackRange) AND (SELECT rank + 2 FROM RackRange)

      UNION
      -- 선택 기업이 상위 2위 이상이라 상위의 2개의 로우값이 부족할 경우 석택기업을 포함한 5개의 기업을 보장함
      SELECT * FROM RankedCompanies
      where rank > (select rank from TargetRank)
      order by rank 
      limit 5
    ) AS combined
    ORDER BY rank --${orderbyView}
    LIMIT 5
  `;
    res.send(serializeBigInt(data));
  } catch (e) {
    res.status(400).send({ message: e.message });
  }
}

export async function getSelections_v(req, res) {
  const { order = "asc", limit = 10, page = 0 } = req.query;
  //page가 false이면 0 -> offset없음
  const offset = page ? (page - 1) * limit : 0;
  //순위를 정의하는 기준
  const sortBy = `"${req.query.sortBy || "selectedCount"}"`;
  const orderByRank = Prisma.sql([sortBy]);
  const orderByScending = Prisma.sql([order]);
  try {
    const totalCount = await prisma.company.count();

    const response = await prisma.$queryRaw`
    WITH RankedCompanies AS (
      SELECT
        *,
        ROW_NUMBER() OVER (ORDER BY ${orderByRank} desc) AS rank
      FROM "public"."Company"
      LIMIT ${Prisma.sql`${parseInt(limit)}`}
      OFFSET ${offset}
    )
    SELECT * FROM RankedCompanies
    -- 순위를 정의하는 기준과 다른 데이터의 정렬기준
    ORDER BY rank ${orderByScending}
    `.then((res) => serializeBigInt(res));

    //쿼리가 2가지라 동시 호출후 Promise.all await 처리
    const [count, data] = await Promise.all([totalCount, response]);

    if (data) {
      const returnData = {
        list: data,
        totalCount: count,
      };
      res.send(returnData);
    } else {
      res.status(404).send({ message: "기업정보를 찾을수 없습니다." });
    }
  } catch (error) {
    res.send({ message: error.message });
  }
}

export async function getSelections(req, res) {
  const { order = "asc", limit = 10, page = 0 } = req.query;
  //page가 false이면 0 -> offset없음
  const offset = page ? (page - 1) * limit : 0;
  //순위를 정의하는 기준
  const sortBy = `"${req.query.sortBy || "selectedCount"}"`;
  const orderByRank = Prisma.sql([sortBy]);
  const orderByScending = Prisma.sql([order]);
  try {
    const totalCount = prisma.company.count();

    const response = prisma.$queryRaw`
    WITH RankedCompanies AS (
      SELECT
        c.*,
        ROW_NUMBER() OVER (ORDER BY c.${orderByRank} DESC) AS rank
      FROM "public"."Company" c
      LIMIT 5
      OFFSET ${offset}
    )
    SELECT
      rc.*,
      rc.rank,
      json_agg(cat.name) AS categories
    FROM RankedCompanies rc
    LEFT JOIN "public"."_CompanyCategories" cc ON rc.id::text = cc."B"
    LEFT JOIN "public"."Category" cat ON cc."A"::text = cat.id::text
    GROUP BY rc.id,rc.rank, rc."name", rc."description",
	rc."brandImage", rc."actualInvestment", rc."virtualInvestment",
	rc."revenue",
	rc."totalEmployees",
	rc."selectedCount",rc."comparedCount",rc."createdAt",
	rc."updatedAt"
    -- 순위를 정의하는 기준과 다른 데이터의 정렬기준
    ORDER BY rank ${orderByScending}
    `.then((res) => serializeBigInt(res));

    //쿼리가 2가지라 동시 호출후 Promise.all await 처리
    const [count, data] = await Promise.all([totalCount, response]);

    if (data) {
      const returnData = {
        list: data,
        totalCount: count,
      };
      res.send(returnData);
    } else {
      res.status(404).send({ message: "기업정보를 찾을수 없습니다." });
    }
  } catch (error) {
    res.send({ message: error.message });
  }
}
