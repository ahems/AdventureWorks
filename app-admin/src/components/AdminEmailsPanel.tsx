import React, { useState } from "react";
import { Mail, Pencil, Trash2, Plus, Check, X, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { toast } from "sonner";

interface EmailAddress {
  EmailAddressID: number;
  BusinessEntityID: number;
  EmailAddress: string;
}

const GET_EMAIL_ADDRESSES = gql`
  query GetEmailAddresses($businessEntityId: Int!) {
    emailAddresses(
      filter: { BusinessEntityID: { eq: $businessEntityId } }
      orderBy: { EmailAddressID: ASC }
    ) {
      items {
        EmailAddressID
        BusinessEntityID
        EmailAddress
      }
    }
  }
`;

const CREATE_EMAIL_ADDRESS = gql`
  mutation CreateEmailAddress($businessEntityId: Int!, $emailAddress: String!) {
    createEmailAddress(
      item: { BusinessEntityID: $businessEntityId, EmailAddress: $emailAddress }
    ) {
      EmailAddressID
      BusinessEntityID
      EmailAddress
    }
  }
`;

const UPDATE_EMAIL_ADDRESS = gql`
  mutation UpdateEmailAddress(
    $businessEntityId: Int!
    $emailAddressId: Int!
    $emailAddress: String!
  ) {
    updateEmailAddress(
      BusinessEntityID: $businessEntityId
      EmailAddressID: $emailAddressId
      item: { EmailAddress: $emailAddress }
    ) {
      EmailAddressID
      BusinessEntityID
      EmailAddress
    }
  }
`;

const DELETE_EMAIL_ADDRESS = gql`
  mutation DeleteEmailAddress($businessEntityId: Int!, $emailAddressId: Int!) {
    deleteEmailAddress(
      BusinessEntityID: $businessEntityId
      EmailAddressID: $emailAddressId
    ) {
      EmailAddressID
    }
  }
`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AdminEmailsPanelProps {
  businessEntityId: number;
}

export const AdminEmailsPanel: React.FC<AdminEmailsPanelProps> = ({
  businessEntityId,
}) => {
  const queryClient = useQueryClient();
  const queryKey = ["admin", "emails", businessEntityId];

  const { data: emails = [], isLoading } = useQuery<EmailAddress[]>({
    queryKey,
    queryFn: async () => {
      const data = (await graphqlClient.request(GET_EMAIL_ADDRESSES, {
        businessEntityId,
      })) as { emailAddresses: { items: EmailAddress[] } };
      return data.emailAddresses.items ?? [];
    },
    enabled: businessEntityId > 0,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey });
    // Also invalidate profile so profile form stays in sync
    queryClient.invalidateQueries({
      queryKey: ["admin", "customer-profile", businessEntityId],
    });
  };

  const createMutation = useMutation({
    mutationFn: async (emailAddress: string) => {
      await graphqlClient.request(CREATE_EMAIL_ADDRESS, {
        businessEntityId,
        emailAddress,
      });
    },
    onSuccess: () => {
      invalidate();
      setNewEmail("");
      setShowAdd(false);
      toast.success("Email address added");
    },
    onError: () => toast.error("Failed to add email address"),
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      emailAddressId,
      emailAddress,
    }: {
      emailAddressId: number;
      emailAddress: string;
    }) => {
      await graphqlClient.request(UPDATE_EMAIL_ADDRESS, {
        businessEntityId,
        emailAddressId,
        emailAddress,
      });
    },
    onSuccess: () => {
      invalidate();
      setEditingId(null);
      setEditValue("");
      toast.success("Email address updated");
    },
    onError: () => toast.error("Failed to update email address"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (emailAddressId: number) => {
      await graphqlClient.request(DELETE_EMAIL_ADDRESS, {
        businessEntityId,
        emailAddressId,
      });
    },
    onSuccess: () => {
      invalidate();
      toast.success("Email address removed");
    },
    onError: () => toast.error("Failed to remove email address"),
  });

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [addError, setAddError] = useState("");
  const [editError, setEditError] = useState("");

  const startEdit = (email: EmailAddress) => {
    setEditingId(email.EmailAddressID);
    setEditValue(email.EmailAddress);
    setEditError("");
  };

  const handleUpdate = (emailAddressId: number) => {
    if (!EMAIL_RE.test(editValue.trim())) {
      setEditError("Enter a valid email address");
      return;
    }
    updateMutation.mutate({ emailAddressId, emailAddress: editValue.trim() });
  };

  const handleAdd = () => {
    if (!EMAIL_RE.test(newEmail.trim())) {
      setAddError("Enter a valid email address");
      return;
    }
    createMutation.mutate(newEmail.trim());
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading email addresses…
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {emails.map((email) =>
        editingId === email.EmailAddressID ? (
          <div key={email.EmailAddressID} className="flex items-start gap-2">
            <div className="flex-1">
              <input
                type="email"
                value={editValue}
                onChange={(e) => {
                  setEditValue(e.target.value);
                  setEditError("");
                }}
                autoFocus
                className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {editError && (
                <p className="text-red-500 text-xs mt-1">{editError}</p>
              )}
            </div>
            <button
              onClick={() => handleUpdate(email.EmailAddressID)}
              disabled={updateMutation.isPending}
              className="flex items-center gap-1 bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {updateMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              Save
            </button>
            <button
              onClick={() => setEditingId(null)}
              className="p-1.5 text-gray-400 hover:text-gray-700 border border-gray-300 rounded-md"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div
            key={email.EmailAddressID}
            className="flex items-center gap-3 p-3 bg-white border-2 border-doodle-text/10"
          >
            <Mail className="w-4 h-4 text-gray-400 shrink-0" />
            <span className="flex-1 text-sm text-gray-800 break-all">
              {email.EmailAddress}
              {email.EmailAddressID === emails[0]?.EmailAddressID && (
                <span className="ml-2 text-xs text-blue-600 font-medium">
                  primary
                </span>
              )}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => startEdit(email)}
                className="p-1.5 text-gray-400 hover:text-blue-600 transition-colors"
                title="Edit email"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  if (!confirm("Remove this email address?")) return;
                  deleteMutation.mutate(email.EmailAddressID);
                }}
                disabled={deleteMutation.isPending}
                className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                title="Delete email"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ),
      )}

      {showAdd ? (
        <div className="flex items-start gap-2 mt-2">
          <div className="flex-1">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => {
                setNewEmail(e.target.value);
                setAddError("");
              }}
              autoFocus
              placeholder="new@example.com"
              className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {addError && (
              <p className="text-red-500 text-xs mt-1">{addError}</p>
            )}
          </div>
          <button
            onClick={handleAdd}
            disabled={createMutation.isPending}
            className="flex items-center gap-1 bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {createMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5" />
            )}
            Add
          </button>
          <button
            onClick={() => {
              setShowAdd(false);
              setNewEmail("");
              setAddError("");
            }}
            className="p-1.5 text-gray-400 hover:text-gray-700 border border-gray-300 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 mt-1"
        >
          <Plus className="w-4 h-4" />
          Add email address
        </button>
      )}
    </div>
  );
};
