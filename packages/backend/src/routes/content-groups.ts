import { ObjectId } from "mongodb";
import { z } from "zod";
import { procedure, router } from "#lib/trpc";
import { isAuthenticated } from "#lib/middleware";
import { UnderscoreID, zodId } from "#lib/mongo";
import * as errors from "#lib/errors";
import { createEventPublisher, createEventSubscription } from "#lib/pub-sub";
import { runWebhooks } from "#lib/webhooks";
import {
  ContentGroup,
  contentGroup,
  getContentsCollection,
  getContentPiecesCollection,
  getContentGroupsCollection,
  getContentPieceVariantsCollection,
  getContentVariantsCollection,
  getWorkspacesCollection,
  FullContentGroup
} from "#database";
import { runGitSyncHook } from "#lib";

type ContentGroupEvent =
  | {
      action: "create";
      data: ContentGroup;
    }
  | {
      action: "update";
      data: Partial<ContentGroup> & { id: string };
    }
  | { action: "delete"; data: { id: string } }
  | { action: "move"; data: ContentGroup }
  | { action: "reorder"; data: { id: string; index: number } };

const publishEvent = createEventPublisher<ContentGroupEvent>(
  (workspaceId) => `contentGroups:${workspaceId}`
);
const basePath = "/content-groups";
const authenticatedProcedure = procedure.use(isAuthenticated);
const rearrangeContentGroups = (
  contentGroups: Array<UnderscoreID<FullContentGroup<ObjectId>>>,
  ids: ObjectId[]
): ContentGroup[] => {
  return ids
    .map((id) => {
      const contentGroup = contentGroups.find((contentGroup) => {
        return contentGroup._id.equals(id);
      });

      if (!contentGroup) return null;

      return {
        id: `${contentGroup!._id}`,
        descendants: contentGroup.descendants.map((id) => `${id}`),
        ancestors: contentGroup.ancestors.map((id) => `${id}`),
        name: contentGroup.name,
        locked: contentGroup.locked
      };
    })
    .filter(Boolean) as ContentGroup[];
};
const contentGroupsRouter = router({
  get: authenticatedProcedure
    .meta({
      openapi: { method: "GET", path: basePath, protect: true },
      permissions: { token: ["contentGroups:read"] }
    })
    .input(
      z.object({
        id: zodId()
      })
    )
    .output(contentGroup)
    .query(async ({ ctx, input }) => {
      const contentGroupsCollection = getContentGroupsCollection(ctx.db);
      const contentGroup = await contentGroupsCollection.findOne({
        _id: new ObjectId(input.id),
        workspaceId: ctx.auth.workspaceId
      });

      if (!contentGroup) throw errors.notFound("contentGroup");

      return {
        id: `${contentGroup._id}`,
        ancestors: contentGroup.ancestors.map((id) => `${id}`),
        descendants: contentGroup.descendants.map((id) => `${id}`),
        name: contentGroup.name,
        locked: contentGroup.locked
      };
    }),
  update: authenticatedProcedure
    .meta({
      openapi: { method: "PUT", path: basePath, protect: true },
      permissions: { session: ["manageDashboard"], token: ["contentGroups:write"] }
    })
    .input(
      contentGroup
        .omit({ ancestors: true, descendants: true })
        .partial()
        .required({ id: true })
        .extend({ ancestor: zodId().optional() })
    )
    .output(z.void())
    .mutation(async ({ ctx, input }) => {
      const { id, ...update } = input;
      const contentGroupsCollection = getContentGroupsCollection(ctx.db);
      const contentGroupId = new ObjectId(id);
      const contentGroup = await contentGroupsCollection.findOne({
        _id: contentGroupId,
        workspaceId: ctx.auth.workspaceId
      });

      if (!contentGroup) throw errors.notFound("contentGroup");

      const ancestorContentGroup =
        "ancestor" in input &&
        (await contentGroupsCollection.findOne({
          _id: new ObjectId(input.ancestor),
          workspaceId: ctx.auth.workspaceId
        }));

      if ("ancestor" in input && !ancestorContentGroup) throw errors.notFound("contentGroup");

      await contentGroupsCollection.updateOne(
        {
          _id: contentGroupId,
          workspaceId: ctx.auth.workspaceId
        },
        {
          $set: {
            ...update,
            ...(ancestorContentGroup && {
              ancestors: [...ancestorContentGroup.ancestors, ancestorContentGroup._id]
            })
          }
        }
      );

      if (ancestorContentGroup) {
        const descendants = await contentGroupsCollection
          .find({
            ancestors: contentGroup._id
          })
          .toArray();

        await contentGroupsCollection.bulkWrite([
          {
            updateOne: {
              filter: { _id: contentGroup.ancestors[contentGroup.ancestors.length - 1] },
              update: { $pull: { descendants: contentGroupId } }
            }
          },
          {
            updateOne: {
              filter: { _id: ancestorContentGroup._id },
              update: { $push: { descendants: contentGroupId } }
            }
          },
          ...descendants.map((descendant) => {
            const descendantAncestors = [
              ...ancestorContentGroup.ancestors,
              ...descendant.ancestors.slice(
                descendant.ancestors.findIndex((_id) => contentGroup._id.equals(_id))
              )
            ];

            return {
              updateOne: {
                filter: { _id: descendant._id },
                update: { $set: { ancestors: descendantAncestors } }
              }
            };
          })
        ]);
      }

      runGitSyncHook(ctx, "contentGroupUpdated", {
        contentGroup,
        ancestor: "ancestor" in input ? input.ancestor : undefined,
        name: "name" in input ? input.name : undefined
      });
      publishEvent(ctx, `${ctx.auth.workspaceId}`, { action: "update", data: { id, ...update } });
    }),
  create: authenticatedProcedure
    .meta({
      openapi: { method: "POST", path: basePath, protect: true },
      permissions: { session: ["manageDashboard"], token: ["contentGroups:write"] }
    })
    .input(
      contentGroup
        .omit({ descendants: true, ancestors: true, id: true })
        .extend({ ancestor: zodId().optional() })
    )
    .output(z.object({ id: zodId() }))
    .mutation(async ({ ctx, input }) => {
      const contentGroupsCollection = getContentGroupsCollection(ctx.db);
      const workspacesCollection = getWorkspacesCollection(ctx.db);
      const ancestor =
        input.ancestor &&
        (await contentGroupsCollection.findOne({
          _id: new ObjectId(input.ancestor),
          workspaceId: ctx.auth.workspaceId
        }));

      if (input.ancestor && !ancestor) throw errors.notFound("contentGroup");

      const contentGroup: UnderscoreID<FullContentGroup<ObjectId>> = {
        name: input.name,
        locked: false,
        descendants: [],
        workspaceId: ctx.auth.workspaceId,
        _id: new ObjectId(),
        ancestors: [],
        ...(ancestor && {
          ancestors: [...ancestor.ancestors, ancestor._id]
        })
      };

      if (ancestor) {
        const { matchedCount } = await contentGroupsCollection.updateOne(
          { _id: ancestor._id },
          { $push: { descendants: contentGroup._id } }
        );

        if (!matchedCount) throw errors.notFound("contentGroup");
      } else {
        await workspacesCollection.updateOne(
          { _id: ctx.auth.workspaceId },
          { $push: { contentGroups: contentGroup._id } }
        );
      }

      await contentGroupsCollection.insertOne(contentGroup);
      publishEvent(ctx, `${ctx.auth.workspaceId}`, {
        action: "create",
        data: {
          id: `${contentGroup._id}`,
          ancestors: contentGroup.ancestors.map((id) => `${id}`),
          descendants: contentGroup.descendants.map((id) => `${id}`),
          ...input
        }
      });
      runGitSyncHook(ctx, "contentGroupCreated", {
        contentGroup
      });
      runWebhooks(ctx, "contentGroupAdded", {
        ...input,
        id: `${contentGroup._id}`,
        ancestors: contentGroup.ancestors.map((id) => `${id}`),
        descendants: contentGroup.descendants.map((id) => `${id}`)
      });

      return { id: `${contentGroup._id}` };
    }),
  delete: authenticatedProcedure
    .meta({
      openapi: { method: "DELETE", path: basePath, protect: true },
      permissions: { session: ["manageDashboard"], token: ["contentGroups:write"] }
    })
    .input(
      z.object({
        id: zodId()
      })
    )
    .output(z.void())
    .mutation(async ({ ctx, input }) => {
      const workspacesCollection = getWorkspacesCollection(ctx.db);
      const contentGroupsCollection = getContentGroupsCollection(ctx.db);
      const contentPiecesCollection = getContentPiecesCollection(ctx.db);
      const contentsCollection = getContentsCollection(ctx.db);
      const contentPieceVariantsCollection = getContentPieceVariantsCollection(ctx.db);
      const contentVariantsCollection = getContentVariantsCollection(ctx.db);
      const contentGroupId = new ObjectId(input.id);
      const contentGroup = await contentGroupsCollection.findOne({
        _id: contentGroupId,
        workspaceId: ctx.auth.workspaceId
      });

      if (!contentGroup) throw errors.notFound("contentGroup");

      if (contentGroup.ancestors.length > 0) {
        await contentGroupsCollection.updateOne(
          { _id: contentGroup.ancestors[contentGroup.ancestors.length - 1] },
          { $pull: { descendants: contentGroupId } }
        );
      } else {
        await workspacesCollection.updateOne(
          { _id: ctx.auth.workspaceId },
          { $pull: { contentGroups: contentGroupId } }
        );
      }

      const nestedContentGroups = await contentGroupsCollection
        .find({
          ancestors: contentGroupId
        })
        .map(({ _id }) => _id)
        .toArray();
      const deletedContentGroupIds = [contentGroupId, ...nestedContentGroups];
      const contentPieceIds = await contentPiecesCollection
        .find({ contentGroupId: { $in: deletedContentGroupIds } })
        .project({ _id: true })
        .map(({ _id }) => _id)
        .toArray();

      await contentGroupsCollection.deleteMany({
        _id: { $in: deletedContentGroupIds },
        workspaceId: ctx.auth.workspaceId
      });
      await contentPiecesCollection.deleteMany({
        _id: { $in: contentPieceIds },
        workspaceId: ctx.auth.workspaceId
      });
      await contentsCollection.deleteMany({
        contentPieceId: { $in: contentPieceIds }
      });
      await contentPieceVariantsCollection.deleteMany({
        contentPieceId: { $in: contentPieceIds },
        workspaceId: ctx.auth.workspaceId
      });
      await contentVariantsCollection.deleteMany({
        contentPieceId: { $in: contentPieceIds }
      });
      runGitSyncHook(ctx, "contentGroupRemoved", { contentGroup });
      runWebhooks(ctx, "contentGroupAdded", {
        ...contentGroup,
        ancestors: contentGroup.ancestors.map((id) => `${id}`),
        descendants: contentGroup.descendants.map((id) => `${id}`),
        id: `${contentGroup._id}`
      });
      publishEvent(ctx, `${ctx.auth.workspaceId}`, {
        action: "delete",
        data: input
      });
      ctx.fastify.search.deleteContent({
        contentPieceId: contentPieceIds,
        workspaceId: ctx.auth.workspaceId
      });
    }),
  listAncestors: authenticatedProcedure
    .input(
      z.object({
        contentGroupId: zodId()
      })
    )
    .output(z.array(contentGroup))
    .query(async ({ ctx, input }) => {
      const contentGroupsCollection = getContentGroupsCollection(ctx.db);
      const contentGroup = await contentGroupsCollection.findOne({
        _id: new ObjectId(input.contentGroupId),
        workspaceId: ctx.auth.workspaceId
      });

      if (!contentGroup) throw errors.notFound("contentGroup");

      const { ancestors } = contentGroup;
      const contentGroups = await contentGroupsCollection
        .find({
          workspaceId: ctx.auth.workspaceId,
          _id: { $in: ancestors }
        })
        .toArray();

      return rearrangeContentGroups(contentGroups, ancestors);
    }),
  list: authenticatedProcedure
    .meta({
      openapi: { method: "GET", path: `${basePath}/list`, protect: true },
      permissions: { token: ["contentGroups:read"] }
    })
    .input(
      z
        .object({
          ancestor: zodId().optional()
        })
        .optional()
    )
    .output(z.array(contentGroup))
    .query(async ({ ctx, input }) => {
      const contentGroupsCollection = getContentGroupsCollection(ctx.db);
      const workspacesCollection = getWorkspacesCollection(ctx.db);
      const ids: ObjectId[] = [];
      const ancestorId = input?.ancestor ? new ObjectId(input.ancestor) : null;

      if (ancestorId) {
        const ancestor = await contentGroupsCollection.findOne({ _id: ancestorId });

        if (!ancestor) throw errors.notFound("contentGroup");

        ids.push(...ancestor.descendants);
      } else {
        const workspace = await workspacesCollection.findOne({ _id: ctx.auth.workspaceId });

        if (!workspace) throw errors.notFound("workspace");

        ids.push(...workspace.contentGroups);
      }

      const contentGroups = await contentGroupsCollection
        .find({
          workspaceId: ctx.auth.workspaceId,
          _id: { $in: ids }
        })
        .toArray();

      return rearrangeContentGroups(contentGroups, ids);
    }),
  move: authenticatedProcedure
    .meta({
      permissions: { session: ["manageDashboard"] }
    })
    .input(
      z.object({
        id: zodId(),
        ancestor: zodId().or(z.null())
      })
    )
    .mutation(async ({ ctx, input }) => {
      const contentGroupsCollection = getContentGroupsCollection(ctx.db);
      const workspacesCollection = getWorkspacesCollection(ctx.db);
      const contentGroup = await contentGroupsCollection.findOne({
        _id: new ObjectId(input.id),
        workspaceId: ctx.auth.workspaceId
      });

      let ancestors: ObjectId[] = [];

      if (!contentGroup) throw errors.notFound("contentGroup");

      // Remove from current ancestor
      if (contentGroup.ancestors.length > 0) {
        const { matchedCount } = await contentGroupsCollection.updateOne(
          {
            _id: contentGroup.ancestors[contentGroup.ancestors.length - 1],
            workspaceId: ctx.auth.workspaceId
          },
          { $pull: { descendants: contentGroup._id } }
        );

        if (!matchedCount) throw errors.notFound("contentGroup");
      } else {
        const { matchedCount } = await workspacesCollection.updateOne(
          {
            _id: ctx.auth.workspaceId
          },
          {
            $pull: { contentGroups: contentGroup._id }
          }
        );

        if (!matchedCount) throw errors.notFound("contentGroup");
      }

      if (input.ancestor) {
        const ancestor = await contentGroupsCollection.findOne({
          _id: new ObjectId(input.ancestor),
          workspaceId: ctx.auth.workspaceId
        });

        if (!ancestor) throw errors.notFound("contentGroup");

        ancestors = [...ancestor.ancestors, ancestor._id];
        await contentGroupsCollection.updateOne(
          { _id: ancestor._id },
          { $push: { descendants: contentGroup._id } }
        );
        await contentGroupsCollection.updateOne({ _id: contentGroup._id }, { $set: { ancestors } });
      } else {
        ancestors = [];
        await workspacesCollection.updateOne(
          { _id: ctx.auth.workspaceId },
          { $push: { contentGroups: contentGroup._id } }
        );
        await contentGroupsCollection.updateOne({ _id: contentGroup._id }, { $set: { ancestors } });
      }

      // Update descendants' ancestors
      const descendants = await contentGroupsCollection
        .find({
          ancestors: contentGroup._id
        })
        .toArray();
      const writeOperations = descendants.map((descendant) => {
        const descendantAncestors = [
          ...ancestors,
          ...descendant.ancestors.slice(
            descendant.ancestors.findIndex((_id) => contentGroup._id.equals(_id))
          )
        ];

        return {
          updateOne: {
            filter: { _id: descendant._id },
            update: { $set: { ancestors: descendantAncestors } }
          }
        };
      });

      if (writeOperations.length > 0) {
        await contentGroupsCollection.bulkWrite(writeOperations);
      }

      runGitSyncHook(ctx, "contentGroupMoved", {
        ancestor: input.ancestor,
        contentGroup
      });
      publishEvent(ctx, `${ctx.auth.workspaceId}`, {
        action: "move",
        data: {
          id: input.id,
          ancestors: ancestors.map((id) => `${id}`),
          descendants: contentGroup.descendants.map((id) => `${id}`),
          name: contentGroup.name,
          locked: contentGroup.locked
        }
      });
      runWebhooks(ctx, "contentGroupMoved", {
        id: input.id,
        ancestors: ancestors.map((id) => `${id}`),
        descendants: contentGroup.descendants.map((id) => `${id}`),
        name: contentGroup.name,
        locked: contentGroup.locked
      });
    }),
  reorder: authenticatedProcedure
    .meta({
      permissions: { session: ["manageDashboard"] }
    })
    .input(
      z.object({
        id: zodId(),
        index: z.number()
      })
    )
    .mutation(async ({ ctx, input }) => {
      const contentGroupsCollection = getContentGroupsCollection(ctx.db);
      const workspacesCollection = getWorkspacesCollection(ctx.db);
      const contentGroup = await contentGroupsCollection.findOne({
        _id: new ObjectId(input.id)
      });

      if (!contentGroup) throw errors.notFound("contentGroup");

      if (contentGroup.ancestors.length > 0) {
        const ancestor = await contentGroupsCollection.findOne({
          _id: contentGroup.ancestors[contentGroup.ancestors.length - 1]
        });

        if (!ancestor) throw errors.notFound("contentGroup");

        const newDescendants = [...ancestor.descendants];

        newDescendants.splice(
          newDescendants.findIndex((newDescendantId) => {
            return newDescendantId.equals(contentGroup._id);
          }),
          1
        );
        newDescendants.splice(input.index, 0, contentGroup._id);
        await contentGroupsCollection.updateOne(
          { _id: ancestor._id },
          { $set: { descendants: newDescendants } }
        );
      } else {
        const workspace = await workspacesCollection.findOne({
          _id: ctx.auth.workspaceId
        });

        if (!workspace) throw errors.notFound("workspace");

        const newContentGroups = [...workspace.contentGroups];

        newContentGroups.splice(
          newContentGroups.findIndex((newContentGroupId) => {
            return newContentGroupId.equals(contentGroup._id);
          }),
          1
        );
        newContentGroups.splice(input.index, 0, contentGroup._id);
        await workspacesCollection.updateOne(
          { _id: ctx.auth.workspaceId },
          { $set: { contentGroups: newContentGroups } }
        );
      }

      publishEvent(ctx, `${ctx.auth.workspaceId}`, {
        action: "reorder",
        data: input
      });
    }),
  changes: authenticatedProcedure.subscription(async ({ ctx }) => {
    return createEventSubscription<ContentGroupEvent>(ctx, `contentGroups:${ctx.auth.workspaceId}`);
  })
});

export { contentGroupsRouter, publishEvent as publishContentGroupEvent };
