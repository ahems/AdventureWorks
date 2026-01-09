import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { toast } from "./use-toast";

export interface EmailAddress {
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

export const useEmailAddresses = (businessEntityId: number) => {
  return useQuery<EmailAddress[]>({
    queryKey: ["emailAddresses", businessEntityId],
    queryFn: async () => {
      const data = (await graphqlClient.request(GET_EMAIL_ADDRESSES, {
        businessEntityId,
      })) as { emailAddresses: { items: EmailAddress[] } };
      return data.emailAddresses.items || [];
    },
    enabled: !!businessEntityId,
  });
};

export const useCreateEmailAddress = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      businessEntityId,
      emailAddress,
    }: {
      businessEntityId: number;
      emailAddress: string;
    }) => {
      const data = (await graphqlClient.request(CREATE_EMAIL_ADDRESS, {
        businessEntityId,
        emailAddress,
      })) as { createEmailAddress: EmailAddress };
      return data.createEmailAddress;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["emailAddresses", variables.businessEntityId],
      });
      toast({
        title: "Success",
        description: "Email address added successfully",
      });
    },
    onError: (error: Error) => {
      console.error("Error creating email address:", error);
      toast({
        title: "Error",
        description:
          error.message || "Failed to add email address. Please try again.",
        variant: "destructive",
      });
    },
  });
};

export const useUpdateEmailAddress = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      businessEntityId,
      emailAddressId,
      emailAddress,
    }: {
      businessEntityId: number;
      emailAddressId: number;
      emailAddress: string;
    }) => {
      const data = (await graphqlClient.request(UPDATE_EMAIL_ADDRESS, {
        businessEntityId,
        emailAddressId,
        emailAddress,
      })) as { updateEmailAddress: EmailAddress };
      return data.updateEmailAddress;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["emailAddresses", variables.businessEntityId],
      });
      // Also invalidate profile query as it includes email
      queryClient.invalidateQueries({
        queryKey: ["profile", variables.businessEntityId],
      });
      toast({
        title: "Success",
        description: "Email address updated successfully",
      });
    },
    onError: (error: Error) => {
      console.error("Error updating email address:", error);
      toast({
        title: "Error",
        description:
          error.message || "Failed to update email address. Please try again.",
        variant: "destructive",
      });
    },
  });
};

export const useDeleteEmailAddress = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      businessEntityId,
      emailAddressId,
    }: {
      businessEntityId: number;
      emailAddressId: number;
    }) => {
      const data = (await graphqlClient.request(DELETE_EMAIL_ADDRESS, {
        businessEntityId,
        emailAddressId,
      })) as { deleteEmailAddress: { EmailAddressID: number } };
      return data.deleteEmailAddress;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["emailAddresses", variables.businessEntityId],
      });
      // Also invalidate profile query as it includes email
      queryClient.invalidateQueries({
        queryKey: ["profile", variables.businessEntityId],
      });
      toast({
        title: "Success",
        description: "Email address removed successfully",
      });
    },
    onError: (error: Error) => {
      console.error("Error deleting email address:", error);
      toast({
        title: "Error",
        description:
          error.message || "Failed to remove email address. Please try again.",
        variant: "destructive",
      });
    },
  });
};
